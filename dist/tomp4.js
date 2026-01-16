/**
 * toMp4.js v1.0.10
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
   * Converts a fragmented MP4 file to a standard MP4 container
   * by extracting samples from fragments and rebuilding the moov box.
   * 
   * @module fmp4/converter
   */
  
  import {
      parseBoxes, findBox, parseChildBoxes, createBox,
      parseTfhd, parseTrun
  } from './utils.js';
  
  // ============================================
  // Moov Rebuilding Functions
  // ============================================
  
  function rebuildMvhd(mvhdBox, duration) {
      const data = new Uint8Array(mvhdBox.data);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const version = data[8];
      const durationOffset = version === 0 ? 24 : 32;
      if (version === 0) view.setUint32(durationOffset, duration);
      else { view.setUint32(durationOffset, 0); view.setUint32(durationOffset + 4, duration); }
      return data;
  }
  
  function rebuildTkhd(tkhdBox, trackInfo, maxDuration) {
      const data = new Uint8Array(tkhdBox.data);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const version = data[8];
      let trackDuration = maxDuration;
      if (trackInfo) { trackDuration = 0; for (const s of trackInfo.samples) trackDuration += s.duration || 0; }
      if (version === 0) view.setUint32(28, trackDuration);
      else { view.setUint32(36, 0); view.setUint32(40, trackDuration); }
      return data;
  }
  
  function rebuildMdhd(mdhdBox, trackInfo, maxDuration) {
      const data = new Uint8Array(mdhdBox.data);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const version = data[8];
      let trackDuration = 0;
      if (trackInfo) for (const s of trackInfo.samples) trackDuration += s.duration || 0;
      const durationOffset = version === 0 ? 24 : 32;
      if (version === 0) view.setUint32(durationOffset, trackDuration);
      else { view.setUint32(durationOffset, 0); view.setUint32(durationOffset + 4, trackDuration); }
      return data;
  }
  
  function rebuildStbl(stblBox, trackInfo) {
      const stblChildren = parseChildBoxes(stblBox);
      const newParts = [];
      for (const child of stblChildren) if (child.type === 'stsd') { newParts.push(child.data); break; }
      const samples = trackInfo?.samples || [];
      const chunkOffsets = trackInfo?.chunkOffsets || [];
  
      // stts
      const sttsEntries = [];
      let curDur = null, count = 0;
      for (const s of samples) {
          const d = s.duration || 0;
          if (d === curDur) count++;
          else { if (curDur !== null) sttsEntries.push({ count, duration: curDur }); curDur = d; count = 1; }
      }
      if (curDur !== null) sttsEntries.push({ count, duration: curDur });
      const sttsData = new Uint8Array(8 + sttsEntries.length * 8);
      const sttsView = new DataView(sttsData.buffer);
      sttsView.setUint32(4, sttsEntries.length);
      let off = 8;
      for (const e of sttsEntries) { sttsView.setUint32(off, e.count); sttsView.setUint32(off + 4, e.duration); off += 8; }
      newParts.push(createBox('stts', sttsData));
  
      // stsc
      const stscEntries = [];
      if (chunkOffsets.length > 0) {
          let currentSampleCount = chunkOffsets[0].sampleCount, firstChunk = 1;
          for (let i = 1; i <= chunkOffsets.length; i++) {
              const sampleCount = i < chunkOffsets.length ? chunkOffsets[i].sampleCount : -1;
              if (sampleCount !== currentSampleCount) {
                  stscEntries.push({ firstChunk, samplesPerChunk: currentSampleCount, sampleDescriptionIndex: 1 });
                  firstChunk = i + 1; currentSampleCount = sampleCount;
              }
          }
      } else stscEntries.push({ firstChunk: 1, samplesPerChunk: samples.length, sampleDescriptionIndex: 1 });
      const stscData = new Uint8Array(8 + stscEntries.length * 12);
      const stscView = new DataView(stscData.buffer);
      stscView.setUint32(4, stscEntries.length);
      off = 8;
      for (const e of stscEntries) { stscView.setUint32(off, e.firstChunk); stscView.setUint32(off + 4, e.samplesPerChunk); stscView.setUint32(off + 8, e.sampleDescriptionIndex); off += 12; }
      newParts.push(createBox('stsc', stscData));
  
      // stsz
      const stszData = new Uint8Array(12 + samples.length * 4);
      const stszView = new DataView(stszData.buffer);
      stszView.setUint32(8, samples.length);
      off = 12;
      for (const s of samples) { stszView.setUint32(off, s.size || 0); off += 4; }
      newParts.push(createBox('stsz', stszData));
  
      // stco
      const numChunks = chunkOffsets.length || 1;
      const stcoData = new Uint8Array(8 + numChunks * 4);
      const stcoView = new DataView(stcoData.buffer);
      stcoView.setUint32(4, numChunks);
      for (let i = 0; i < numChunks; i++) stcoView.setUint32(8 + i * 4, chunkOffsets[i]?.offset || 0);
      newParts.push(createBox('stco', stcoData));
  
      // ctts
      const hasCtts = samples.some(s => s.compositionTimeOffset);
      if (hasCtts) {
          const cttsEntries = [];
          let curOff = null; count = 0;
          for (const s of samples) {
              const o = s.compositionTimeOffset || 0;
              if (o === curOff) count++;
              else { if (curOff !== null) cttsEntries.push({ count, offset: curOff }); curOff = o; count = 1; }
          }
          if (curOff !== null) cttsEntries.push({ count, offset: curOff });
          const cttsData = new Uint8Array(8 + cttsEntries.length * 8);
          const cttsView = new DataView(cttsData.buffer);
          cttsView.setUint32(4, cttsEntries.length);
          off = 8;
          for (const e of cttsEntries) { cttsView.setUint32(off, e.count); cttsView.setInt32(off + 4, e.offset); off += 8; }
          newParts.push(createBox('ctts', cttsData));
      }
  
      // stss
      const syncSamples = [];
      for (let i = 0; i < samples.length; i++) {
          const flags = samples[i].flags;
          if (flags !== undefined) { if (!((flags >> 16) & 0x1)) syncSamples.push(i + 1); }
      }
      if (syncSamples.length > 0 && syncSamples.length < samples.length) {
          const stssData = new Uint8Array(8 + syncSamples.length * 4);
          const stssView = new DataView(stssData.buffer);
          stssView.setUint32(4, syncSamples.length);
          off = 8;
          for (const n of syncSamples) { stssView.setUint32(off, n); off += 4; }
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
  
  function rebuildMdia(mdiaBox, trackInfo, maxDuration) {
      const mdiaChildren = parseChildBoxes(mdiaBox);
      const newParts = [];
      for (const child of mdiaChildren) {
          if (child.type === 'minf') newParts.push(rebuildMinf(child, trackInfo));
          else if (child.type === 'mdhd') newParts.push(rebuildMdhd(child, trackInfo, maxDuration));
          else newParts.push(child.data);
      }
      return createBox('mdia', ...newParts);
  }
  
  function rebuildTrak(trakBox, trackIdMap, maxDuration) {
      const trakChildren = parseChildBoxes(trakBox);
      let trackId = 1;
      for (const child of trakChildren) {
          if (child.type === 'tkhd') {
              const view = new DataView(child.data.buffer, child.data.byteOffset, child.data.byteLength);
              trackId = child.data[8] === 0 ? view.getUint32(20) : view.getUint32(28);
          }
      }
      const trackInfo = trackIdMap.get(trackId);
      const newParts = [];
      let hasEdts = false;
      for (const child of trakChildren) {
          if (child.type === 'edts') { hasEdts = true; newParts.push(child.data); }
          else if (child.type === 'mdia') newParts.push(rebuildMdia(child, trackInfo, maxDuration));
          else if (child.type === 'tkhd') newParts.push(rebuildTkhd(child, trackInfo, maxDuration));
          else newParts.push(child.data);
      }
      if (!hasEdts && trackInfo) {
          let trackDuration = 0;
          for (const s of trackInfo.samples) trackDuration += s.duration || 0;
          const elstData = new Uint8Array(20);
          const elstView = new DataView(elstData.buffer);
          elstView.setUint32(4, 1); elstView.setUint32(8, maxDuration); elstView.setInt32(12, 0); elstView.setInt16(16, 1);
          const elst = createBox('elst', elstData);
          const edts = createBox('edts', elst);
          const tkhdIndex = newParts.findIndex(p => p.length >= 8 && String.fromCharCode(p[4], p[5], p[6], p[7]) === 'tkhd');
          if (tkhdIndex >= 0) newParts.splice(tkhdIndex + 1, 0, edts);
      }
      return createBox('trak', ...newParts);
  }
  
  function updateStcoOffsets(output, ftypSize, moovSize) {
      const mdatContentOffset = ftypSize + moovSize + 8;
      const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
      function scan(start, end) {
          let pos = start;
          while (pos + 8 <= end) {
              const size = view.getUint32(pos);
              if (size < 8) break;
              const type = String.fromCharCode(output[pos + 4], output[pos + 5], output[pos + 6], output[pos + 7]);
              if (type === 'stco') {
                  const entryCount = view.getUint32(pos + 12);
                  for (let i = 0; i < entryCount; i++) {
                      const entryPos = pos + 16 + i * 4;
                      view.setUint32(entryPos, mdatContentOffset + view.getUint32(entryPos));
                  }
              } else if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) scan(pos + 8, pos + size);
              pos += size;
          }
      }
      scan(0, output.byteLength);
  }
  
  // ============================================
  // Main Converter Function
  // ============================================
  
  /**
   * Convert fragmented MP4 to standard MP4
   * @param {Uint8Array} fmp4Data - fMP4 data
   * @returns {Uint8Array} Standard MP4 data
   */
  function convertFmp4ToMp4(fmp4Data) {
      const boxes = parseBoxes(fmp4Data);
      const ftyp = findBox(boxes, 'ftyp');
      const moov = findBox(boxes, 'moov');
      if (!ftyp || !moov) throw new Error('Invalid fMP4: missing ftyp or moov');
  
      const moovChildren = parseChildBoxes(moov);
      const originalTrackIds = [];
      for (const child of moovChildren) {
          if (child.type === 'trak') {
              const trakChildren = parseChildBoxes(child);
              for (const tc of trakChildren) {
                  if (tc.type === 'tkhd') {
                      const view = new DataView(tc.data.buffer, tc.data.byteOffset, tc.data.byteLength);
                      originalTrackIds.push(tc.data[8] === 0 ? view.getUint32(20) : view.getUint32(28));
                  }
              }
          }
      }
  
      const tracks = new Map();
      const mdatChunks = [];
      let combinedMdatOffset = 0;
  
      for (let i = 0; i < boxes.length; i++) {
          const box = boxes[i];
          if (box.type === 'moof') {
              const moofChildren = parseChildBoxes(box);
              const moofStart = box.offset;
              let nextMdatOffset = 0;
              for (let j = i + 1; j < boxes.length; j++) {
                  if (boxes[j].type === 'mdat') { nextMdatOffset = boxes[j].offset; break; }
                  if (boxes[j].type === 'moof') break;
              }
              for (const child of moofChildren) {
                  if (child.type === 'traf') {
                      const trafChildren = parseChildBoxes(child);
                      const tfhd = findBox(trafChildren, 'tfhd');
                      const trun = findBox(trafChildren, 'trun');
                      if (tfhd && trun) {
                          const tfhdInfo = parseTfhd(tfhd.data);
                          const { samples, dataOffset } = parseTrun(trun.data, tfhdInfo);
                          if (!tracks.has(tfhdInfo.trackId)) tracks.set(tfhdInfo.trackId, { samples: [], chunkOffsets: [] });
                          const track = tracks.get(tfhdInfo.trackId);
                          const chunkOffset = combinedMdatOffset + (moofStart + dataOffset) - (nextMdatOffset + 8);
                          track.chunkOffsets.push({ offset: chunkOffset, sampleCount: samples.length });
                          track.samples.push(...samples);
                      }
                  }
              }
          } else if (box.type === 'mdat') {
              mdatChunks.push({ data: box.data.subarray(8), offset: combinedMdatOffset });
              combinedMdatOffset += box.data.subarray(8).byteLength;
          }
      }
  
      const totalMdatSize = mdatChunks.reduce((sum, c) => sum + c.data.byteLength, 0);
      const combinedMdat = new Uint8Array(totalMdatSize);
      for (const chunk of mdatChunks) combinedMdat.set(chunk.data, chunk.offset);
  
      const trackIdMap = new Map();
      const fmp4TrackIds = Array.from(tracks.keys()).sort((a, b) => a - b);
      for (let i = 0; i < fmp4TrackIds.length && i < originalTrackIds.length; i++) {
          trackIdMap.set(originalTrackIds[i], tracks.get(fmp4TrackIds[i]));
      }
  
      let maxDuration = 0;
      for (const [, track] of tracks) {
          let dur = 0;
          for (const s of track.samples) dur += s.duration || 0;
          maxDuration = Math.max(maxDuration, dur);
      }
  
      const newMoovParts = [];
      for (const child of moovChildren) {
          if (child.type === 'mvex') continue;
          if (child.type === 'trak') newMoovParts.push(rebuildTrak(child, trackIdMap, maxDuration));
          else if (child.type === 'mvhd') newMoovParts.push(rebuildMvhd(child, maxDuration));
          else newMoovParts.push(child.data);
      }
  
      const newMoov = createBox('moov', ...newMoovParts);
      const newMdat = createBox('mdat', combinedMdat);
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
  toMp4.version = '1.0.10';

  return toMp4;
});
