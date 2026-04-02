/**
 * Smart Rendering
 *
 * Re-encodes the boundary GOP of an HLS segment to produce a
 * frame-accurate cut point. Decodes preroll frames, re-encodes
 * the target frame as a new keyframe, and re-encodes subsequent
 * frames until the next original keyframe.
 *
 * @module codecs/smart-render
 */

import { H264Decoder, YUVFrame } from './h264-decoder.js';
import { H264Encoder } from './h264-encoder.js';
import { TSParser, getCodecInfo } from '../parsers/mpegts.js';

/**
 * Smart-render a TS segment to start at a precise frame.
 *
 * Takes a TS segment and a target start time (relative to segment start).
 * Returns an array of NAL units where:
 * - Frames before targetTime are removed
 * - The frame at targetTime is re-encoded as an IDR keyframe
 * - Frames between targetTime and next original keyframe are re-encoded as I-frames
 * - Frames after the next original keyframe use original compressed data
 *
 * @param {TSParser} parser - Parsed TS segment
 * @param {number} targetStartTime - Start time in seconds (relative to segment)
 * @param {object} [options]
 * @param {number} [options.endTime] - End time in seconds (relative to segment)
 * @param {number} [options.qp=20] - Encoding quality (lower = better, 0-51)
 * @returns {object} { videoAUs, audioAUs, actualStartTime }
 */
export function smartRender(parser, targetStartTime, options = {}) {
  const { endTime = Infinity, qp = 20 } = options;
  const PTS = 90000;
  const targetPts = targetStartTime * PTS;
  const endPts = endTime * PTS;

  const videoAUs = parser.videoAccessUnits;
  const audioAUs = parser.audioAccessUnits;

  if (videoAUs.length === 0) {
    return { videoAUs: [], audioAUs: [], actualStartTime: targetStartTime };
  }

  // Find the keyframe at or before targetTime
  let keyframeIdx = 0;
  for (let i = 0; i < videoAUs.length; i++) {
    if (videoAUs[i].pts > targetPts) break;
    if (_isKeyframe(videoAUs[i])) keyframeIdx = i;
  }

  // Find the target frame (first frame at or after targetTime)
  let targetIdx = keyframeIdx;
  for (let i = keyframeIdx; i < videoAUs.length; i++) {
    if (videoAUs[i].pts >= targetPts) { targetIdx = i; break; }
  }

  // Find the next keyframe after targetIdx
  let nextKeyframeIdx = videoAUs.length;
  for (let i = targetIdx + 1; i < videoAUs.length; i++) {
    if (_isKeyframe(videoAUs[i])) { nextKeyframeIdx = i; break; }
  }

  // Find end frame
  let endIdx = videoAUs.length;
  for (let i = 0; i < videoAUs.length; i++) {
    if (videoAUs[i].pts >= endPts) { endIdx = i; break; }
  }

  // If target is already a keyframe, no smart rendering needed
  if (targetIdx === keyframeIdx) {
    const clippedVideo = videoAUs.slice(targetIdx, endIdx);
    const startPts = clippedVideo.length > 0 ? clippedVideo[0].pts : 0;
    const clippedAudio = audioAUs.filter(au => au.pts >= startPts && au.pts < (endIdx < videoAUs.length ? videoAUs[endIdx].pts : Infinity));
    return {
      videoAUs: clippedVideo,
      audioAUs: clippedAudio,
      actualStartTime: startPts / PTS,
    };
  }

  // ── Smart rendering: decode preroll, re-encode boundary ──

  // Step 1: Decode preroll frames to get pixel data at targetIdx
  const decoder = new H264Decoder();
  let targetFrame = null;

  for (let i = keyframeIdx; i <= targetIdx; i++) {
    const frame = decoder.decodeAccessUnit(videoAUs[i].nalUnits);
    if (frame && i === targetIdx) targetFrame = frame;
  }

  if (!targetFrame) {
    // Fallback: couldn't decode, start at keyframe instead
    const clippedVideo = videoAUs.slice(keyframeIdx, endIdx);
    const startPts = clippedVideo[0].pts;
    return {
      videoAUs: clippedVideo,
      audioAUs: audioAUs.filter(au => au.pts >= startPts),
      actualStartTime: startPts / PTS,
    };
  }

  // Step 2: Re-encode target frame as IDR
  const encoder = new H264Encoder();
  const encodedNals = encoder.encode(
    targetFrame.Y, targetFrame.U, targetFrame.V,
    targetFrame.width, targetFrame.height, qp
  );

  // Step 3: Build output access units
  const outputVideo = [];
  const targetPtsActual = videoAUs[targetIdx].pts;
  const targetDts = videoAUs[targetIdx].dts;

  // First AU: the re-encoded IDR frame (with new SPS/PPS)
  outputVideo.push({
    nalUnits: encodedNals, // [SPS, PPS, IDR]
    pts: targetPtsActual,
    dts: targetDts,
    _smartRendered: true,
  });

  // Step 4: Re-encode frames between target and next keyframe as I-frames
  for (let i = targetIdx + 1; i < Math.min(nextKeyframeIdx, endIdx); i++) {
    // Decode this frame
    const frame = decoder.decodeAccessUnit(videoAUs[i].nalUnits);
    if (frame) {
      const frameNals = encoder.encode(frame.Y, frame.U, frame.V,
        frame.width, frame.height, qp);
      // Use only the IDR NAL (skip SPS/PPS for subsequent frames)
      const idrOnly = frameNals.filter(n => (n[0] & 0x1F) === 5);
      outputVideo.push({
        nalUnits: idrOnly,
        pts: videoAUs[i].pts,
        dts: videoAUs[i].dts,
        _smartRendered: true,
      });
    }
  }

  // Step 5: Original compressed data from next keyframe onward
  for (let i = nextKeyframeIdx; i < endIdx; i++) {
    outputVideo.push(videoAUs[i]);
  }

  // Clip audio to match video range
  const audioStartPts = targetPtsActual;
  const audioEndPts = endIdx < videoAUs.length ? videoAUs[endIdx - 1].pts + PTS : Infinity;
  const outputAudio = audioAUs.filter(au => au.pts >= audioStartPts && au.pts < audioEndPts);

  return {
    videoAUs: outputVideo,
    audioAUs: outputAudio,
    actualStartTime: targetPtsActual / PTS,
    smartRenderedFrames: Math.min(nextKeyframeIdx, endIdx) - targetIdx,
    originalFrames: Math.max(0, endIdx - nextKeyframeIdx),
  };
}

function _isKeyframe(au) {
  for (const nal of au.nalUnits) {
    if ((nal[0] & 0x1F) === 5) return true; // IDR
  }
  return false;
}

export default smartRender;
