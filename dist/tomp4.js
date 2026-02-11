/**
 * toMp4.js v1.2.1
 * Convert MPEG-TS and fMP4 to standard MP4
 * https://github.com/TVWIT/toMp4.js
 * MIT License
 */
(function(global, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define(factory);
  } else {
    global = global || self;
    global.toMp4 = factory();
  }
})(this, function() {
  'use strict';

  // ============================================
  // MPEG-TS to MP4 Converter
  // ============================================
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
   * Clip access units to a time range, snapping to keyframes for decode
   * but using edit list for precise playback timing
   * 
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
  
    // Find keyframe at or before startTime (needed for decoding)
    let keyframeIdx = 0;
    for (let i = 0; i < videoAUs.length; i++) {
      if (videoAUs[i].pts > startPts) break;
      if (isKeyframe(videoAUs[i])) keyframeIdx = i;
    }
  
    // Find first frame at or after endTime
    let endIdx = videoAUs.length;
    for (let i = keyframeIdx; i < videoAUs.length; i++) {
      if (videoAUs[i].pts >= endPts) {
        endIdx = i;
        break;
      }
    }
  
    // Clip video starting from keyframe (for proper decoding)
    const clippedVideo = videoAUs.slice(keyframeIdx, endIdx);
  
    if (clippedVideo.length === 0) {
      return {
        video: [],
        audio: [],
        actualStartTime: startTime,
        actualEndTime: endTime,
        offset: 0,
        preroll: 0
      };
    }
  
    // Get PTS of keyframe and requested start
    const keyframePts = clippedVideo[0].pts;
    const lastFramePts = clippedVideo[clippedVideo.length - 1].pts;
  
    // Pre-roll: time between keyframe and requested start
    // This is the time the decoder needs to process but player shouldn't display
    const prerollPts = Math.max(0, startPts - keyframePts);
  
    // Clip audio to the REQUESTED time range (not from keyframe)
    // Audio doesn't need keyframe pre-roll
    const audioStartPts = startPts;
    const audioEndPts = Math.min(endPts, lastFramePts + 90000); // Include audio slightly past last video
    const clippedAudio = audioAUs.filter(au => au.pts >= audioStartPts && au.pts < audioEndPts);
  
    // Normalize video timestamps so keyframe starts at 0
    const offset = keyframePts;
    for (const au of clippedVideo) {
      au.pts -= offset;
      au.dts -= offset;
    }
  
    // Normalize audio timestamps so it starts at 0 (matching video playback start after preroll)
    // Audio doesn't have preroll, so it should start at PTS 0 to sync with video after edit list
    const audioOffset = audioStartPts;  // Use requested start, not keyframe
    for (const au of clippedAudio) {
      au.pts -= audioOffset;
    }
  
    return {
      video: clippedVideo,
      audio: clippedAudio,
      actualStartTime: keyframePts / PTS_PER_SECOND,  // Where decode starts (keyframe)
      actualEndTime: lastFramePts / PTS_PER_SECOND,
      requestedStartTime: startTime,                   // Where playback should start
      requestedEndTime: endTime,
      offset,
      preroll: prerollPts  // Edit list will use this to skip pre-roll frames during playback
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
  function analyzeTsData(tsData) {
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
  
  function convertTsToMp4(tsData, options = {}) {
    const log = options.onProgress || (() => { });
  
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
  
    // Track preroll for edit list (used for precise clipping)
    let clipPreroll = 0;
  
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
      clipPreroll = clipResult.preroll;
  
      // Update PTS arrays to match
      parser.videoPts = clipResult.video.map(au => au.pts);
      parser.videoDts = clipResult.video.map(au => au.dts);
      parser.audioPts = clipResult.audio.map(au => au.pts);
  
      const prerollMs = (clipPreroll / 90).toFixed(0);
      const endTimeStr = clipResult.requestedEndTime === Infinity ? 'end' : clipResult.requestedEndTime.toFixed(2) + 's';
      const clipDuration = clipResult.requestedEndTime === Infinity
        ? (clipResult.actualEndTime - clipResult.requestedStartTime).toFixed(2)
        : (clipResult.requestedEndTime - clipResult.requestedStartTime).toFixed(2);
      log(`Clipped: ${clipResult.requestedStartTime.toFixed(2)}s - ${endTimeStr} (${clipDuration}s, ${prerollMs}ms preroll)`, { phase: 'convert', percent: 80 });
    }
  
    log(`Building MP4...`, { phase: 'convert', percent: 85 });
    const muxer = new MP4Muxer(parser, { preroll: clipPreroll });
    const { width, height } = muxer.getVideoDimensions();
    log(`Dimensions: ${width}x${height}`);
  
    const result = muxer.build();
    log(`Complete`, { phase: 'convert', percent: 100 });
    return result;
  }
  
  { TSParser };
  default convertTsToMp4;

  // ============================================
  // fMP4 to MP4 Converter  
  // ============================================
  /**
   * fMP4 to Standard MP4 Converter
   *
   * Converts fragmented MP4 data to standard MP4 and supports
   * sample-level clipping for fMP4 inputs.
   *
   * @module fmp4/converter
   */
  
  import {
      parseBoxes,
      findBox,
      parseChildBoxes,
      createBox,
      parseTfhd,
      parseTfdt,
      parseTrun,
      getMovieTimescale,
  } from './utils.js';
  
  function createFullBox(type, version, flags, ...payloads) {
      const header = new Uint8Array(4);
      header[0] = version;
      header[1] = (flags >> 16) & 0xff;
      header[2] = (flags >> 8) & 0xff;
      header[3] = flags & 0xff;
      return createBox(type, header, ...payloads);
  }
  
  function sumSampleDurations(samples) {
      let total = 0;
      for (const sample of samples) total += sample.duration || 0;
      return total;
  }
  
  function toMovieTimescale(value, trackTimescale, movieTimescale) {
      if (!trackTimescale || !movieTimescale) return value;
      return Math.round((value * movieTimescale) / trackTimescale);
  }
  
  function isSyncSample(sample) {
      const flags = sample.flags;
      if (flags === undefined || flags === null) return true;
      return ((flags >> 16) & 0x1) === 0;
  }
  
  function parseTrex(trexData) {
      const view = new DataView(trexData.buffer, trexData.byteOffset, trexData.byteLength);
      return {
          trackId: view.getUint32(12),
          defaultSampleDuration: view.getUint32(20),
          defaultSampleSize: view.getUint32(24),
          defaultSampleFlags: view.getUint32(28),
      };
  }
  
  function extractTrexDefaults(moovBox) {
      const defaults = new Map();
      const moovChildren = parseChildBoxes(moovBox);
      const mvex = findBox(moovChildren, 'mvex');
      if (!mvex) return defaults;
  
      const mvexChildren = parseChildBoxes(mvex);
      for (const child of mvexChildren) {
          if (child.type !== 'trex') continue;
          const trex = parseTrex(child.data);
          defaults.set(trex.trackId, trex);
      }
      return defaults;
  }
  
  function extractTrackMetadata(moovBox) {
      const trackMetadata = new Map();
      const trackOrder = [];
      const moovChildren = parseChildBoxes(moovBox);
  
      for (const child of moovChildren) {
          if (child.type !== 'trak') continue;
          const trakChildren = parseChildBoxes(child);
  
          let trackId = null;
          let timescale = 0;
          let handlerType = 'unknown';
  
          for (const trakChild of trakChildren) {
              if (trakChild.type === 'tkhd') {
                  const view = new DataView(trakChild.data.buffer, trakChild.data.byteOffset, trakChild.data.byteLength);
                  trackId = trakChild.data[8] === 0 ? view.getUint32(20) : view.getUint32(28);
              } else if (trakChild.type === 'mdia') {
                  const mdiaChildren = parseChildBoxes(trakChild);
                  for (const mdiaChild of mdiaChildren) {
                      if (mdiaChild.type === 'mdhd') {
                          const view = new DataView(mdiaChild.data.buffer, mdiaChild.data.byteOffset, mdiaChild.data.byteLength);
                          timescale = mdiaChild.data[8] === 0 ? view.getUint32(20) : view.getUint32(28);
                      } else if (mdiaChild.type === 'hdlr' && mdiaChild.data.byteLength >= 20) {
                          handlerType = String.fromCharCode(
                              mdiaChild.data[16],
                              mdiaChild.data[17],
                              mdiaChild.data[18],
                              mdiaChild.data[19],
                          );
                      }
                  }
              }
          }
  
          if (trackId !== null) {
              trackMetadata.set(trackId, {
                  trackId,
                  timescale: timescale || 90000,
                  handlerType,
              });
              trackOrder.push(trackId);
          }
      }
  
      return { trackMetadata, trackOrder };
  }
  
  function cloneSample(sample) {
      return {
          duration: sample.duration || 0,
          size: sample.size || 0,
          flags: sample.flags,
          compositionTimeOffset: sample.compositionTimeOffset || 0,
          dts: sample.dts || 0,
          pts: sample.pts || 0,
          byteOffset: sample.byteOffset || 0,
      };
  }
  
  function normalizeSamples(samples, baseDts) {
      return samples.map((sample) => {
          const next = cloneSample(sample);
          next.dts -= baseDts;
          next.pts -= baseDts;
          return next;
      });
  }
  
  function clipVideoSamples(samples, startTick, endTick) {
      if (!samples.length) {
          return { samples: [], mediaTime: 0, playbackDuration: 0 };
      }
  
      let requestedStartIndex = samples.length;
      for (let i = 0; i < samples.length; i++) {
          const sampleEnd = (samples[i].pts || 0) + (samples[i].duration || 0);
          if (sampleEnd > startTick) {
              requestedStartIndex = i;
              break;
          }
      }
      if (requestedStartIndex >= samples.length) {
          return { samples: [], mediaTime: 0, playbackDuration: 0 };
      }
  
      let decodeStartIndex = requestedStartIndex;
      for (let i = requestedStartIndex; i >= 0; i--) {
          if (isSyncSample(samples[i])) {
              decodeStartIndex = i;
              break;
          }
      }
  
      let endIndex = samples.length;
      if (Number.isFinite(endTick)) {
          for (let i = decodeStartIndex; i < samples.length; i++) {
              if ((samples[i].pts || 0) >= endTick) {
                  endIndex = i;
                  break;
              }
          }
      }
      if (endIndex <= decodeStartIndex) {
          return { samples: [], mediaTime: 0, playbackDuration: 0 };
      }
  
      const selected = samples.slice(decodeStartIndex, endIndex);
      const decodeStartDts = selected[0].dts || 0;
      const mediaTime = Math.max(0, startTick - decodeStartDts);
      const normalized = normalizeSamples(selected, decodeStartDts);
      const decodeDuration = sumSampleDurations(normalized);
      const maxPlayable = Math.max(0, decodeDuration - mediaTime);
      const requested = Number.isFinite(endTick) ? Math.max(0, endTick - startTick) : maxPlayable;
      const playbackDuration = Math.min(requested, maxPlayable);
  
      return {
          samples: normalized,
          mediaTime,
          playbackDuration,
      };
  }
  
  function clipNonVideoSamples(samples, startTick, endTick) {
      if (!samples.length) {
          return { samples: [], mediaTime: 0, playbackDuration: 0 };
      }
  
      let startIndex = 0;
      while (startIndex < samples.length && (samples[startIndex].pts || 0) < startTick) {
          startIndex++;
      }
      if (startIndex >= samples.length) {
          return { samples: [], mediaTime: 0, playbackDuration: 0 };
      }
  
      let endIndex = samples.length;
      if (Number.isFinite(endTick)) {
          for (let i = startIndex; i < samples.length; i++) {
              if ((samples[i].pts || 0) >= endTick) {
                  endIndex = i;
                  break;
              }
          }
      }
      if (endIndex <= startIndex) {
          return { samples: [], mediaTime: 0, playbackDuration: 0 };
      }
  
      const selected = samples.slice(startIndex, endIndex);
      const decodeStartDts = selected[0].dts || 0;
      const normalized = normalizeSamples(selected, decodeStartDts);
      const decodeDuration = sumSampleDurations(normalized);
      const requested = Number.isFinite(endTick) ? Math.max(0, endTick - startTick) : decodeDuration;
      const playbackDuration = Math.min(requested, decodeDuration);
  
      return {
          samples: normalized,
          mediaTime: 0,
          playbackDuration,
      };
  }
  
  function applyClipToTracks(tracks, options = {}) {
      const hasStart = Number.isFinite(options.startTime);
      const hasEnd = Number.isFinite(options.endTime);
      if (!hasStart && !hasEnd) {
          for (const [, track] of tracks) {
              if (!track.samples.length) continue;
              const baseDts = track.samples[0].dts || 0;
              track.samples = normalizeSamples(track.samples, baseDts);
              track.mediaTime = 0;
              track.playbackDuration = sumSampleDurations(track.samples);
          }
          return tracks;
      }
  
      const startSec = hasStart ? Math.max(0, options.startTime) : 0;
      const endSec = hasEnd ? Math.max(startSec, options.endTime) : Infinity;
  
      let videoTrackId = null;
      for (const [trackId, track] of tracks) {
          if (track.handlerType === 'vide' && track.samples.length > 0) {
              videoTrackId = trackId;
              break;
          }
      }
  
      const clipped = new Map();
      for (const [trackId, track] of tracks) {
          if (!track.samples.length) continue;
  
          const startTick = Math.round(startSec * track.timescale);
          const endTick = Number.isFinite(endSec) ? Math.round(endSec * track.timescale) : Infinity;
          const clip = trackId === videoTrackId
              ? clipVideoSamples(track.samples, startTick, endTick)
              : clipNonVideoSamples(track.samples, startTick, endTick);
  
          if (!clip.samples.length) continue;
  
          clipped.set(trackId, {
              ...track,
              samples: clip.samples,
              mediaTime: clip.mediaTime,
              playbackDuration: clip.playbackDuration,
              chunkOffsets: [],
          });
      }
  
      return clipped;
  }
  
  function collectTrackSamples(boxes, trackMetadata, trexDefaults) {
      const tracks = new Map();
      const mdatChunks = [];
      let combinedMdatOffset = 0;
  
      for (let i = 0; i < boxes.length; i++) {
          const box = boxes[i];
          if (box.type === 'moof') {
              const moofChildren = parseChildBoxes(box);
              const moofStart = box.offset;
  
              let nextMdatOffset = -1;
              for (let j = i + 1; j < boxes.length; j++) {
                  if (boxes[j].type === 'mdat') {
                      nextMdatOffset = boxes[j].offset;
                      break;
                  }
                  if (boxes[j].type === 'moof') break;
              }
              if (nextMdatOffset < 0) continue;
  
              const mdatContentStartAbs = nextMdatOffset + 8;
  
              for (const child of moofChildren) {
                  if (child.type !== 'traf') continue;
  
                  const trafChildren = parseChildBoxes(child);
                  const tfhdBox = findBox(trafChildren, 'tfhd');
                  if (!tfhdBox) continue;
  
                  const tfhdView = new DataView(tfhdBox.data.buffer, tfhdBox.data.byteOffset, tfhdBox.data.byteLength);
                  const trackId = tfhdView.getUint32(12);
                  const tfhd = parseTfhd(tfhdBox.data, trexDefaults.get(trackId) || {});
                  const tfdtBox = findBox(trafChildren, 'tfdt');
                  let decodeTime = tfdtBox ? parseTfdt(tfdtBox.data) : 0;
                  let runDataCursorAbs = null;
  
                  if (!tracks.has(trackId)) {
                      const meta = trackMetadata.get(trackId) || {};
                      tracks.set(trackId, {
                          trackId,
                          timescale: meta.timescale || 90000,
                          handlerType: meta.handlerType || 'unknown',
                          samples: [],
                          chunkOffsets: [],
                          mediaTime: 0,
                          playbackDuration: 0,
                      });
                  }
                  const track = tracks.get(trackId);
  
                  for (const trafChild of trafChildren) {
                      if (trafChild.type !== 'trun') continue;
                      const { samples, dataOffset, flags } = parseTrun(trafChild.data, tfhd);
                      const runSize = samples.reduce((sum, sample) => sum + (sample.size || 0), 0);
  
                      let dataStartAbs;
                      if (flags & 0x1) {
                          const baseAbs = (tfhd.flags & 0x1) ? tfhd.baseDataOffset : moofStart;
                          dataStartAbs = baseAbs + dataOffset;
                      } else if (runDataCursorAbs !== null) {
                          dataStartAbs = runDataCursorAbs;
                      } else {
                          dataStartAbs = mdatContentStartAbs;
                      }
  
                      let sampleByteOffset = combinedMdatOffset + Math.max(0, dataStartAbs - mdatContentStartAbs);
                      for (const sample of samples) {
                          const dts = decodeTime;
                          const pts = dts + (sample.compositionTimeOffset || 0);
                          track.samples.push({
                              ...sample,
                              dts,
                              pts,
                              byteOffset: sampleByteOffset,
                          });
                          decodeTime += sample.duration || 0;
                          sampleByteOffset += sample.size || 0;
                      }
  
                      runDataCursorAbs = dataStartAbs + runSize;
                  }
              }
          } else if (box.type === 'mdat') {
              const data = box.data.subarray(8);
              mdatChunks.push({ data, offset: combinedMdatOffset });
              combinedMdatOffset += data.byteLength;
          }
      }
  
      const combinedMdat = new Uint8Array(combinedMdatOffset);
      for (const chunk of mdatChunks) {
          combinedMdat.set(chunk.data, chunk.offset);
      }
  
      return { tracks, combinedMdat };
  }
  
  function rebuildMdatContent(tracks, trackOrder, sourceMdat) {
      const orderedTrackIds = trackOrder.filter((trackId) => tracks.has(trackId));
      for (const trackId of tracks.keys()) {
          if (!orderedTrackIds.includes(trackId)) orderedTrackIds.push(trackId);
      }
  
      let totalSize = 0;
      for (const trackId of orderedTrackIds) {
          const track = tracks.get(trackId);
          for (const sample of track.samples) totalSize += sample.size || 0;
      }
  
      const mdatData = new Uint8Array(totalSize);
      let writeOffset = 0;
  
      for (const trackId of orderedTrackIds) {
          const track = tracks.get(trackId);
          if (!track || !track.samples.length) {
              if (track) track.chunkOffsets = [];
              continue;
          }
  
          track.chunkOffsets = [{ offset: writeOffset, sampleCount: track.samples.length }];
          for (const sample of track.samples) {
              const start = sample.byteOffset || 0;
              const end = start + (sample.size || 0);
              if (start < 0 || end > sourceMdat.byteLength) {
                  throw new Error(`Invalid sample byte range for track ${trackId}: ${start}-${end}`);
              }
              mdatData.set(sourceMdat.subarray(start, end), writeOffset);
              sample.byteOffset = writeOffset;
              writeOffset += sample.size || 0;
          }
      }
  
      return mdatData;
  }
  
  function calculateMovieDuration(tracks, movieTimescale) {
      let maxDuration = 0;
      for (const [, track] of tracks) {
          const fallback = Math.max(0, sumSampleDurations(track.samples) - (track.mediaTime || 0));
          const playbackDuration = track.playbackDuration > 0 ? track.playbackDuration : fallback;
          track.playbackDuration = playbackDuration;
          track.movieDuration = toMovieTimescale(playbackDuration, track.timescale, movieTimescale);
          maxDuration = Math.max(maxDuration, track.movieDuration);
      }
      return maxDuration;
  }
  
  function rebuildMvhd(mvhdBox, duration) {
      const data = new Uint8Array(mvhdBox.data);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const version = data[8];
      const durationOffset = version === 0 ? 24 : 32;
      if (version === 0) {
          view.setUint32(durationOffset, duration);
      } else {
          view.setUint32(durationOffset, 0);
          view.setUint32(durationOffset + 4, duration);
      }
      return data;
  }
  
  function rebuildTkhd(tkhdBox, trackInfo, maxMovieDuration) {
      const data = new Uint8Array(tkhdBox.data);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const version = data[8];
      const duration = trackInfo?.movieDuration ?? maxMovieDuration;
      if (version === 0) view.setUint32(28, duration);
      else {
          view.setUint32(36, 0);
          view.setUint32(40, duration);
      }
      return data;
  }
  
  function rebuildMdhd(mdhdBox, trackInfo) {
      const data = new Uint8Array(mdhdBox.data);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const version = data[8];
      const duration = sumSampleDurations(trackInfo?.samples || []);
      const durationOffset = version === 0 ? 24 : 32;
      if (version === 0) {
          view.setUint32(durationOffset, duration);
      } else {
          view.setUint32(durationOffset, 0);
          view.setUint32(durationOffset + 4, duration);
      }
      return data;
  }
  
  function rebuildStbl(stblBox, trackInfo) {
      const stblChildren = parseChildBoxes(stblBox);
      const newParts = [];
      for (const child of stblChildren) {
          if (child.type === 'stsd') {
              newParts.push(child.data);
              break;
          }
      }
  
      const samples = trackInfo?.samples || [];
      const chunkOffsets = trackInfo?.chunkOffsets || [];
  
      // stts
      const sttsEntries = [];
      let currentDuration = null;
      let currentCount = 0;
      for (const sample of samples) {
          const duration = sample.duration || 0;
          if (duration === currentDuration) currentCount++;
          else {
              if (currentDuration !== null) {
                  sttsEntries.push({ count: currentCount, duration: currentDuration });
              }
              currentDuration = duration;
              currentCount = 1;
          }
      }
      if (currentDuration !== null) {
          sttsEntries.push({ count: currentCount, duration: currentDuration });
      }
      const sttsData = new Uint8Array(8 + sttsEntries.length * 8);
      const sttsView = new DataView(sttsData.buffer);
      sttsView.setUint32(4, sttsEntries.length);
      let offset = 8;
      for (const entry of sttsEntries) {
          sttsView.setUint32(offset, entry.count);
          sttsView.setUint32(offset + 4, entry.duration);
          offset += 8;
      }
      newParts.push(createBox('stts', sttsData));
  
      // stsc
      const stscEntries = [];
      if (chunkOffsets.length > 0) {
          let currentSampleCount = chunkOffsets[0].sampleCount;
          let firstChunk = 1;
          for (let i = 1; i <= chunkOffsets.length; i++) {
              const sampleCount = i < chunkOffsets.length ? chunkOffsets[i].sampleCount : -1;
              if (sampleCount !== currentSampleCount) {
                  stscEntries.push({
                      firstChunk,
                      samplesPerChunk: currentSampleCount,
                      sampleDescriptionIndex: 1,
                  });
                  firstChunk = i + 1;
                  currentSampleCount = sampleCount;
              }
          }
      }
      const stscData = new Uint8Array(8 + stscEntries.length * 12);
      const stscView = new DataView(stscData.buffer);
      stscView.setUint32(4, stscEntries.length);
      offset = 8;
      for (const entry of stscEntries) {
          stscView.setUint32(offset, entry.firstChunk);
          stscView.setUint32(offset + 4, entry.samplesPerChunk);
          stscView.setUint32(offset + 8, entry.sampleDescriptionIndex);
          offset += 12;
      }
      newParts.push(createBox('stsc', stscData));
  
      // stsz
      const stszData = new Uint8Array(12 + samples.length * 4);
      const stszView = new DataView(stszData.buffer);
      stszView.setUint32(8, samples.length);
      offset = 12;
      for (const sample of samples) {
          stszView.setUint32(offset, sample.size || 0);
          offset += 4;
      }
      newParts.push(createBox('stsz', stszData));
  
      // stco
      const stcoData = new Uint8Array(8 + chunkOffsets.length * 4);
      const stcoView = new DataView(stcoData.buffer);
      stcoView.setUint32(4, chunkOffsets.length);
      for (let i = 0; i < chunkOffsets.length; i++) {
          stcoView.setUint32(8 + i * 4, chunkOffsets[i].offset || 0);
      }
      newParts.push(createBox('stco', stcoData));
  
      // ctts
      const hasCtts = samples.some((sample) => sample.compositionTimeOffset);
      if (hasCtts) {
          const cttsEntries = [];
          let currentOffset = null;
          currentCount = 0;
          for (const sample of samples) {
              const compositionOffset = sample.compositionTimeOffset || 0;
              if (compositionOffset === currentOffset) currentCount++;
              else {
                  if (currentOffset !== null) {
                      cttsEntries.push({ count: currentCount, offset: currentOffset });
                  }
                  currentOffset = compositionOffset;
                  currentCount = 1;
              }
          }
          if (currentOffset !== null) {
              cttsEntries.push({ count: currentCount, offset: currentOffset });
          }
          const cttsData = new Uint8Array(8 + cttsEntries.length * 8);
          const cttsView = new DataView(cttsData.buffer);
          cttsView.setUint32(4, cttsEntries.length);
          offset = 8;
          for (const entry of cttsEntries) {
              cttsView.setUint32(offset, entry.count);
              cttsView.setInt32(offset + 4, entry.offset);
              offset += 8;
          }
          newParts.push(createBox('ctts', cttsData));
      }
  
      // stss (video sync samples)
      const syncSamples = [];
      for (let i = 0; i < samples.length; i++) {
          if (isSyncSample(samples[i])) syncSamples.push(i + 1);
      }
      if (syncSamples.length > 0 && syncSamples.length < samples.length) {
          const stssData = new Uint8Array(8 + syncSamples.length * 4);
          const stssView = new DataView(stssData.buffer);
          stssView.setUint32(4, syncSamples.length);
          offset = 8;
          for (const sampleNumber of syncSamples) {
              stssView.setUint32(offset, sampleNumber);
              offset += 4;
          }
          newParts.push(createBox('stss', stssData));
      }
  
      return createBox('stbl', ...newParts);
  }
  
  function rebuildMinf(minfBox, trackInfo) {
      const minfChildren = parseChildBoxes(minfBox);
      const newParts = [];
      for (const child of minfChildren) {
          if (child.type === 'stbl') newParts.push(rebuildStbl(child, trackInfo));
          else newParts.push(child.data);
      }
      return createBox('minf', ...newParts);
  }
  
  function rebuildMdia(mdiaBox, trackInfo) {
      const mdiaChildren = parseChildBoxes(mdiaBox);
      const newParts = [];
      for (const child of mdiaChildren) {
          if (child.type === 'minf') newParts.push(rebuildMinf(child, trackInfo));
          else if (child.type === 'mdhd') newParts.push(rebuildMdhd(child, trackInfo));
          else newParts.push(child.data);
      }
      return createBox('mdia', ...newParts);
  }
  
  function rebuildTrak(trakBox, trackInfoMap, maxMovieDuration) {
      const trakChildren = parseChildBoxes(trakBox);
      let trackId = null;
      for (const child of trakChildren) {
          if (child.type !== 'tkhd') continue;
          const view = new DataView(child.data.buffer, child.data.byteOffset, child.data.byteLength);
          trackId = child.data[8] === 0 ? view.getUint32(20) : view.getUint32(28);
      }
      if (trackId === null) return null;
  
      const trackInfo = trackInfoMap.get(trackId);
      if (!trackInfo || !trackInfo.samples.length) return null;
  
      const newParts = [];
      for (const child of trakChildren) {
          if (child.type === 'edts') continue;
          if (child.type === 'mdia') newParts.push(rebuildMdia(child, trackInfo));
          else if (child.type === 'tkhd') newParts.push(rebuildTkhd(child, trackInfo, maxMovieDuration));
          else newParts.push(child.data);
      }
  
      const elstPayload = new Uint8Array(16);
      const elstView = new DataView(elstPayload.buffer);
      elstView.setUint32(0, 1);
      elstView.setUint32(4, trackInfo.movieDuration ?? maxMovieDuration);
      elstView.setInt32(8, Math.max(0, Math.round(trackInfo.mediaTime || 0)));
      elstView.setUint16(12, 1);
      elstView.setUint16(14, 0);
      const elst = createFullBox('elst', 0, 0, elstPayload);
      const edts = createBox('edts', elst);
  
      const tkhdIndex = newParts.findIndex((part) =>
          part.length >= 8 && String.fromCharCode(part[4], part[5], part[6], part[7]) === 'tkhd',
      );
      if (tkhdIndex >= 0) newParts.splice(tkhdIndex + 1, 0, edts);
      else newParts.unshift(edts);
  
      return createBox('trak', ...newParts);
  }
  
  function updateStcoOffsets(output, ftypSize, moovSize) {
      const mdatContentOffset = ftypSize + moovSize + 8;
      const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  
      function scan(start, end) {
          let position = start;
          while (position + 8 <= end) {
              const size = view.getUint32(position);
              if (size < 8) break;
              const type = String.fromCharCode(
                  output[position + 4],
                  output[position + 5],
                  output[position + 6],
                  output[position + 7],
              );
  
              if (type === 'stco') {
                  const entryCount = view.getUint32(position + 12);
                  for (let i = 0; i < entryCount; i++) {
                      const entryPos = position + 16 + i * 4;
                      const relativeOffset = view.getUint32(entryPos);
                      view.setUint32(entryPos, mdatContentOffset + relativeOffset);
                  }
              } else if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) {
                  scan(position + 8, position + size);
              }
  
              position += size;
          }
      }
  
      scan(0, output.byteLength);
  }
  
  /**
   * Convert fragmented MP4 to standard MP4
   * @param {Uint8Array} fmp4Data - fMP4 data
   * @param {object} [options] - Optional clip settings
   * @param {number} [options.startTime] - Clip start time (seconds)
   * @param {number} [options.endTime] - Clip end time (seconds)
   * @returns {Uint8Array} Standard MP4 data
   */
  function convertFmp4ToMp4(fmp4Data, options = {}) {
      const boxes = parseBoxes(fmp4Data);
      const ftyp = findBox(boxes, 'ftyp');
      const moov = findBox(boxes, 'moov');
      if (!ftyp || !moov) throw new Error('Invalid fMP4: missing ftyp or moov');
  
      const movieTimescale = getMovieTimescale(moov);
      const { trackMetadata, trackOrder } = extractTrackMetadata(moov);
      const trexDefaults = extractTrexDefaults(moov);
      const { tracks, combinedMdat } = collectTrackSamples(boxes, trackMetadata, trexDefaults);
  
      if (tracks.size === 0) throw new Error('Invalid fMP4: no track fragments found');
  
      const clippedTracks = applyClipToTracks(tracks, options);
      if (clippedTracks.size === 0) {
          throw new Error('Clip range produced no samples');
      }
  
      const rebuiltMdat = rebuildMdatContent(clippedTracks, trackOrder, combinedMdat);
      const maxMovieDuration = calculateMovieDuration(clippedTracks, movieTimescale);
  
      const moovChildren = parseChildBoxes(moov);
      const newMoovParts = [];
      for (const child of moovChildren) {
          if (child.type === 'mvex') continue;
          if (child.type === 'trak') {
              const trak = rebuildTrak(child, clippedTracks, maxMovieDuration);
              if (trak) newMoovParts.push(trak);
          } else if (child.type === 'mvhd') {
              newMoovParts.push(rebuildMvhd(child, maxMovieDuration));
          } else {
              newMoovParts.push(child.data);
          }
      }
  
      const newMoov = createBox('moov', ...newMoovParts);
      const newMdat = createBox('mdat', rebuiltMdat);
      const output = new Uint8Array(ftyp.size + newMoov.byteLength + newMdat.byteLength);
      output.set(ftyp.data, 0);
      output.set(newMoov, ftyp.size);
      output.set(newMdat, ftyp.size + newMoov.byteLength);
      updateStcoOffsets(output, ftyp.size, newMoov.byteLength);
      return output;
  }
  
  default convertFmp4ToMp4;

  // ============================================
  // Main API
  // ============================================
  function isMpegTs(data) {
    if (data.length < 4) return false;
    if (data[0] === 0x47) return true;
    for (var i = 0; i < Math.min(188, data.length); i++) {
      if (data[i] === 0x47 && i + 188 < data.length && data[i + 188] === 0x47) return true;
    }
    return false;
  }

  function isFmp4(data) {
    if (data.length < 8) return false;
    var type = String.fromCharCode(data[4], data[5], data[6], data[7]);
    return type === 'ftyp' || type === 'styp' || type === 'moof';
  }

  function isStandardMp4(data) {
    if (data.length < 12) return false;
    var type = String.fromCharCode(data[4], data[5], data[6], data[7]);
    if (type !== 'ftyp') return false;
    var offset = 0;
    var view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    var hasMoov = false, hasMoof = false;
    while (offset + 8 <= data.length) {
      var size = view.getUint32(offset);
      if (size < 8) break;
      var boxType = String.fromCharCode(data[offset+4], data[offset+5], data[offset+6], data[offset+7]);
      if (boxType === 'moov') hasMoov = true;
      if (boxType === 'moof') hasMoof = true;
      offset += size;
    }
    return hasMoov && !hasMoof;
  }

  function detectFormat(data) {
    if (isMpegTs(data)) return 'mpegts';
    if (isStandardMp4(data)) return 'mp4';
    if (isFmp4(data)) return 'fmp4';
    return 'unknown';
  }

  function toMp4(data) {
    var uint8 = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    var format = detectFormat(uint8);
    switch (format) {
      case 'mpegts': return convertTsToMp4(uint8);
      case 'fmp4': return convertFmp4ToMp4(uint8);
      case 'mp4': return uint8;
      default: throw new Error('Unrecognized video format. Expected MPEG-TS or fMP4.');
    }
  }

  toMp4.fromTs = convertTsToMp4;
  toMp4.fromFmp4 = convertFmp4ToMp4;
  toMp4.detectFormat = detectFormat;
  toMp4.isMpegTs = isMpegTs;
  toMp4.isFmp4 = isFmp4;
  toMp4.isStandardMp4 = isStandardMp4;
  toMp4.version = '1.2.1';

  return toMp4;
});
