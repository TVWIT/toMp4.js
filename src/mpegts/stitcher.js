/**
 * MPEG-TS Segment Stitching
 * Combine multiple MPEG-TS segments into a single MP4 or continuous TS stream
 * Pure JavaScript - no dependencies
 */

import { TSParser } from '../parsers/mpegts.js';
import { MP4Muxer } from '../muxers/mp4.js';
import { TSMuxer } from '../muxers/mpegts.js';

// ============================================
// Utilities
// ============================================

/**
 * Normalize input to Uint8Array
 */
function normalizeInput(input) {
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  return input;
}

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
 * Calculate segment duration from timestamps
 * Returns duration in PTS ticks (90kHz)
 */
function getSegmentDuration(timestamps) {
  if (!timestamps || timestamps.length < 2) return 0;

  const first = timestamps[0];
  const last = timestamps[timestamps.length - 1];

  // Estimate last frame duration as average
  const avgDuration = (last - first) / (timestamps.length - 1);

  return Math.round(last - first + avgDuration);
}

/**
 * Build ADTS header for AAC frame
 * @param {number} dataLength - Length of AAC data (without header)
 * @param {number} sampleRate - Audio sample rate
 * @param {number} channels - Number of audio channels
 * @returns {Uint8Array} 7-byte ADTS header
 */
function buildAdtsHeader(dataLength, sampleRate, channels) {
  const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const samplingFreqIndex = SAMPLE_RATES.indexOf(sampleRate);
  const freqIndex = samplingFreqIndex >= 0 ? samplingFreqIndex : 3; // Default to 48000

  const frameLength = dataLength + 7; // ADTS header is 7 bytes

  const header = new Uint8Array(7);
  header[0] = 0xFF; // Sync word
  header[1] = 0xF1; // MPEG-4, Layer 0, no CRC
  header[2] = (1 << 6) | (freqIndex << 2) | ((channels >> 2) & 0x01); // AAC-LC, freq index, channel config high bit
  header[3] = ((channels & 0x03) << 6) | ((frameLength >> 11) & 0x03);
  header[4] = (frameLength >> 3) & 0xFF;
  header[5] = ((frameLength & 0x07) << 5) | 0x1F;
  header[6] = 0xFC;

  return header;
}

/**
 * Extract SPS and PPS from video access units
 */
function extractSpsPps(videoAccessUnits) {
  let sps = null;
  let pps = null;

  for (const au of videoAccessUnits) {
    for (const nalUnit of au.nalUnits) {
      const nalType = nalUnit[0] & 0x1F;
      if (nalType === 7 && !sps) sps = nalUnit;
      if (nalType === 8 && !pps) pps = nalUnit;
      if (sps && pps) return { sps, pps };
    }
  }

  return { sps, pps };
}

// ============================================
// Core Parsing Logic
// ============================================

/**
 * Parse multiple TS segments and combine with continuous timestamps
 *
 * @param {Uint8Array[]} segments - Array of TS segment data
 * @returns {object} Combined parser-like object compatible with MP4Muxer
 */
function parseAndCombineSegments(segments) {
  if (!segments || segments.length === 0) {
    throw new Error('stitchTs: At least one segment is required');
  }

  let runningVideoPts = 0;
  let runningAudioPts = 0;

  const combined = {
    videoAccessUnits: [],
    audioAccessUnits: [],
    videoPts: [],
    videoDts: [],
    audioPts: [],
    // Metadata from first segment with data
    audioSampleRate: null,
    audioChannels: null,
    videoStreamType: null,
    audioStreamType: null
  };

  for (let i = 0; i < segments.length; i++) {
    const segmentData = normalizeInput(segments[i]);

    const parser = new TSParser();
    parser.parse(segmentData);
    parser.finalize();

    // Skip empty segments
    if (parser.videoAccessUnits.length === 0 && parser.audioAccessUnits.length === 0) {
      continue;
    }

    // Capture metadata from first segment with data
    if (combined.audioSampleRate === null && parser.audioSampleRate) {
      combined.audioSampleRate = parser.audioSampleRate;
      combined.audioChannels = parser.audioChannels;
    }
    if (combined.videoStreamType === null && parser.videoStreamType) {
      combined.videoStreamType = parser.videoStreamType;
    }
    if (combined.audioStreamType === null && parser.audioStreamType) {
      combined.audioStreamType = parser.audioStreamType;
    }

    // Calculate this segment's duration for next offset
    const segmentVideoDuration = getSegmentDuration(parser.videoDts);
    const segmentAudioDuration = getSegmentDuration(parser.audioPts);

    // Offset and append video access units
    for (const au of parser.videoAccessUnits) {
      combined.videoAccessUnits.push({
        nalUnits: au.nalUnits,
        pts: au.pts + runningVideoPts,
        dts: au.dts + runningVideoPts
      });
      combined.videoPts.push(au.pts + runningVideoPts);
      combined.videoDts.push(au.dts + runningVideoPts);
    }

    // Offset and append audio access units
    for (const au of parser.audioAccessUnits) {
      combined.audioAccessUnits.push({
        data: au.data,
        pts: au.pts + runningAudioPts
      });
      combined.audioPts.push(au.pts + runningAudioPts);
    }

    // Advance running offsets for next segment
    runningVideoPts += segmentVideoDuration;
    runningAudioPts += segmentAudioDuration;
  }

  if (combined.videoAccessUnits.length === 0) {
    throw new Error('stitchTs: No video frames found in any segment');
  }

  return combined;
}

// ============================================
// Public API
// ============================================

/**
 * Stitch multiple MPEG-TS segments into a single standard MP4
 *
 * @param {(Uint8Array | ArrayBuffer)[]} segments - Array of TS segment data
 * @returns {Uint8Array} MP4 data
 *
 * @example
 * const mp4Data = stitchTs([segment1, segment2, segment3]);
 */
export function stitchTs(segments) {
  const combined = parseAndCombineSegments(segments);
  const muxer = new MP4Muxer(combined);
  return muxer.build();
}

/**
 * Concatenate multiple MPEG-TS segments into a single continuous TS stream
 *
 * @param {(Uint8Array | ArrayBuffer)[]} segments - Array of TS segment data
 * @returns {Uint8Array} Combined MPEG-TS data with continuous timestamps
 *
 * @example
 * const tsData = concatTs([segment1, segment2, segment3]);
 */
export function concatTs(segments) {
  const combined = parseAndCombineSegments(segments);
  const { sps, pps } = extractSpsPps(combined.videoAccessUnits);

  const muxer = new TSMuxer();

  if (sps && pps) {
    muxer.setSpsPps(sps, pps);
  }
  muxer.setHasAudio(combined.audioAccessUnits.length > 0);

  // Queue all audio samples (need to wrap raw AAC in ADTS)
  const sampleRate = combined.audioSampleRate || 48000;
  const channels = combined.audioChannels || 2;

  for (const au of combined.audioAccessUnits) {
    // Build ADTS frame from raw AAC data
    const header = buildAdtsHeader(au.data.length, sampleRate, channels);
    const adtsFrame = new Uint8Array(header.length + au.data.length);
    adtsFrame.set(header, 0);
    adtsFrame.set(au.data, header.length);
    muxer.addAudioSample(adtsFrame, au.pts);
  }

  // Add video samples using NAL units directly
  for (const au of combined.videoAccessUnits) {
    const isKey = isKeyframe(au);
    muxer.addVideoNalUnits(au.nalUnits, isKey, au.pts, au.dts);
  }

  muxer.flush();
  return muxer.build();
}

export { parseAndCombineSegments, isKeyframe, extractSpsPps };
export default stitchTs;
