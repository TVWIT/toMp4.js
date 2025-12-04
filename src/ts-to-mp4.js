/**
 * MPEG-TS to MP4 Converter
 * Pure JavaScript - no dependencies
 * 
 * SUPPORTED (remux only, no transcoding):
 * ───────────────────────────────────────
 * Video:
 *   ✅ H.264/AVC  (0x1B)
 *   ✅ H.265/HEVC (0x24)
 * 
 * Audio:
 *   ✅ AAC        (0x0F)
 *   ✅ AAC-LATM   (0x11)
 * 
 * NOT SUPPORTED (requires transcoding):
 * ─────────────────────────────────────
 *   ❌ MPEG-1 Video (0x01)
 *   ❌ MPEG-2 Video (0x02)
 *   ❌ MPEG-1 Audio (0x03)
 *   ❌ MPEG-2 Audio (0x04)
 *   ❌ AC-3/Dolby   (0x81)
 *   ❌ E-AC-3       (0x87)
 */

import { TSParser, getCodecInfo } from './parsers/mpegts.js';
import { MP4Muxer } from './muxers/mp4.js';


/**
 * Check if a video access unit contains a keyframe (IDR NAL unit)
 */
function isKeyframe(accessUnit) {
  for (const nalUnit of accessUnit.nalUnits) {
    const nalType = nalUnit[0] & 0x1F;
    if (nalType === 5) return true; // IDR slice
  }
  return false;
}

/**
 * Clip access units to a time range, snapping to keyframes
 * @param {Array} videoAUs - Video access units
 * @param {Array} audioAUs - Audio access units  
 * @param {number} startTime - Start time in seconds
 * @param {number} endTime - End time in seconds
 * @returns {object} Clipped access units and info
 */
function clipAccessUnits(videoAUs, audioAUs, startTime, endTime) {
  const PTS_PER_SECOND = 90000;
  const startPts = startTime * PTS_PER_SECOND;
  const endPts = endTime * PTS_PER_SECOND;
  
  // Find keyframe at or before startTime
  let startIdx = 0;
  for (let i = 0; i < videoAUs.length; i++) {
    if (videoAUs[i].pts > startPts) break;
    if (isKeyframe(videoAUs[i])) startIdx = i;
  }
  
  // Find first frame after endTime
  let endIdx = videoAUs.length;
  for (let i = startIdx; i < videoAUs.length; i++) {
    if (videoAUs[i].pts >= endPts) {
      endIdx = i;
      break;
    }
  }
  
  // Clip video
  const clippedVideo = videoAUs.slice(startIdx, endIdx);
  
  // Get actual PTS range from clipped video
  const actualStartPts = clippedVideo.length > 0 ? clippedVideo[0].pts : 0;
  const actualEndPts = clippedVideo.length > 0 ? clippedVideo[clippedVideo.length - 1].pts : 0;
  
  // Clip audio to match video time range
  const clippedAudio = audioAUs.filter(au => au.pts >= actualStartPts && au.pts <= actualEndPts);
  
  // Normalize timestamps so clip starts at 0
  const offset = actualStartPts;
  for (const au of clippedVideo) {
    au.pts -= offset;
    au.dts -= offset;
  }
  for (const au of clippedAudio) {
    au.pts -= offset;
  }
  
  return {
    video: clippedVideo,
    audio: clippedAudio,
    actualStartTime: actualStartPts / PTS_PER_SECOND,
    actualEndTime: actualEndPts / PTS_PER_SECOND,
    offset
  };
}

/**
 * Convert MPEG-TS data to MP4
 * 
 * @param {Uint8Array} tsData - MPEG-TS data
 * @param {object} options - Optional settings
 * @param {function} options.onProgress - Progress callback
 * @param {number} options.startTime - Start time in seconds (snaps to nearest keyframe)
 * @param {number} options.endTime - End time in seconds
 * @returns {Uint8Array} MP4 data
 * @throws {Error} If codecs are unsupported or no video found
 */
/**
 * Analyze MPEG-TS data without converting
 * Returns duration, keyframe positions, and stream info
 * 
 * @param {Uint8Array} tsData - MPEG-TS data
 * @returns {object} Analysis results
 */
export function analyzeTsData(tsData) {
  const parser = new TSParser();
  parser.parse(tsData);
  parser.finalize();
  
  const PTS_PER_SECOND = 90000;
  
  // Find keyframes and their timestamps
  const keyframes = [];
  for (let i = 0; i < parser.videoAccessUnits.length; i++) {
    if (isKeyframe(parser.videoAccessUnits[i])) {
      keyframes.push({
        index: i,
        time: parser.videoAccessUnits[i].pts / PTS_PER_SECOND
      });
    }
  }
  
  // Calculate duration
  const videoDuration = parser.videoPts.length > 0 
    ? (Math.max(...parser.videoPts) - Math.min(...parser.videoPts)) / PTS_PER_SECOND
    : 0;
  const audioDuration = parser.audioPts.length > 0
    ? (Math.max(...parser.audioPts) - Math.min(...parser.audioPts)) / PTS_PER_SECOND
    : 0;
  
  return {
    duration: Math.max(videoDuration, audioDuration),
    videoFrames: parser.videoAccessUnits.length,
    audioFrames: parser.audioAccessUnits.length,
    keyframes,
    keyframeCount: keyframes.length,
    videoCodec: getCodecInfo(parser.videoStreamType).name,
    audioCodec: getCodecInfo(parser.audioStreamType).name,
    audioSampleRate: parser.audioSampleRate,
    audioChannels: parser.audioChannels
  };
}

export function convertTsToMp4(tsData, options = {}) {
  const log = options.onProgress || (() => {});
  
  log(`Parsing...`, { phase: 'convert', percent: 52 });
  const parser = new TSParser();
  parser.parse(tsData);
  parser.finalize();
  
  const debug = parser.debug;
  const videoInfo = getCodecInfo(parser.videoStreamType);
  const audioInfo = getCodecInfo(parser.audioStreamType);
  
  // Log parsing results
  log(`Parsed ${debug.packets} TS packets`, { phase: 'convert', percent: 55 });
  log(`PAT: ${debug.patFound ? '✓' : '✗'}, PMT: ${debug.pmtFound ? '✓' : '✗'}`);
  log(`Video: ${parser.videoPid ? `PID ${parser.videoPid}` : 'none'} → ${videoInfo.name}`);
  const audioDetails = [];
  if (parser.audioSampleRate) audioDetails.push(`${parser.audioSampleRate}Hz`);
  if (parser.audioChannels) audioDetails.push(`${parser.audioChannels}ch`);
  log(`Audio: ${parser.audioPid ? `PID ${parser.audioPid}` : 'none'} → ${audioInfo.name}${audioDetails.length ? ` (${audioDetails.join(', ')})` : ''}`);
  
  // Check for structural issues first
  if (!debug.patFound) {
    throw new Error('Invalid MPEG-TS: No PAT (Program Association Table) found. File may be corrupted or not MPEG-TS format.');
  }
  
  if (!debug.pmtFound) {
    throw new Error('Invalid MPEG-TS: No PMT (Program Map Table) found. File may be corrupted or missing stream info.');
  }
  
  // Check for unsupported video codec BEFORE we report frame counts
  if (parser.videoStreamType && !videoInfo.supported) {
    throw new Error(
      `Unsupported video codec: ${videoInfo.name}\n` +
      `This library only supports H.264 and H.265 video.\n` +
      `Your file needs to be transcoded to H.264 first.`
    );
  }
  
  // Check for unsupported audio codec
  if (parser.audioStreamType && !audioInfo.supported) {
    throw new Error(
      `Unsupported audio codec: ${audioInfo.name}\n` +
      `This library only supports AAC audio.\n` +
      `Your file needs to be transcoded to AAC first.`
    );
  }
  
  // Check if we found any supported video
  if (!parser.videoPid) {
    throw new Error(
      'No supported video stream found in MPEG-TS.\n' +
      'This library supports: H.264/AVC, H.265/HEVC'
    );
  }
  
  log(`Frames: ${parser.videoAccessUnits.length} video, ${parser.audioAccessUnits.length} audio`, { phase: 'convert', percent: 60 });
  if (debug.audioPesStarts) {
    log(`Audio: ${debug.audioPesStarts} PES starts → ${debug.audioPesCount || 0} processed → ${debug.audioFramesInPes || 0} ADTS frames${debug.audioSkipped ? ` (${debug.audioSkipped} skipped)` : ''}`);
  }
  
  if (parser.videoAccessUnits.length === 0) {
    throw new Error('Video stream found but no frames could be extracted. File may be corrupted.');
  }
  
  // Report timestamp normalization
  if (debug.timestampNormalized) {
    const offsetMs = (debug.timestampOffset / 90).toFixed(1);
    log(`Timestamps normalized: -${offsetMs}ms offset`);
  }
  
  log(`Processing...`, { phase: 'convert', percent: 70 });
  
  // Apply time range clipping if specified
  if (options.startTime !== undefined || options.endTime !== undefined) {
    const startTime = options.startTime || 0;
    const endTime = options.endTime !== undefined ? options.endTime : Infinity;
    
    const clipResult = clipAccessUnits(
      parser.videoAccessUnits,
      parser.audioAccessUnits,
      startTime,
      endTime
    );
    
    parser.videoAccessUnits = clipResult.video;
    parser.audioAccessUnits = clipResult.audio;
    
    // Update PTS arrays to match
    parser.videoPts = clipResult.video.map(au => au.pts);
    parser.videoDts = clipResult.video.map(au => au.dts);
    parser.audioPts = clipResult.audio.map(au => au.pts);
    
    log(`Clipped: ${clipResult.actualStartTime.toFixed(2)}s - ${clipResult.actualEndTime.toFixed(2)}s (${clipResult.video.length} video, ${clipResult.audio.length} audio frames)`, { phase: 'convert', percent: 80 });
  }
  
  log(`Building MP4...`, { phase: 'convert', percent: 85 });
  const muxer = new MP4Muxer(parser);
  const { width, height } = muxer.getVideoDimensions();
  log(`Dimensions: ${width}x${height}`);
  
  const result = muxer.build();
  log(`Complete`, { phase: 'convert', percent: 100 });
  return result;
}

export { TSParser };
export default convertTsToMp4;

