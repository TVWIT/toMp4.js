/**
 * Smart Rendering via WebCodecs
 *
 * Re-encodes the boundary GOP of an HLS segment using the browser's
 * native WebCodecs API. Decodes preroll frames, re-encodes the target
 * frame as a new keyframe, and re-encodes subsequent frames until the
 * next original keyframe. Original compressed data is used from the
 * next keyframe onward.
 *
 * Falls back to keyframe-accurate clipping when WebCodecs is unavailable
 * (e.g., Node.js).
 *
 * @module codecs/smart-render
 */

/**
 * Check if WebCodecs is available in the current environment.
 */
export function isSmartRenderSupported() {
  return typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined';
}

/**
 * Smart-render a TS segment to produce a frame-accurate cut.
 *
 * Decodes from the keyframe before targetTime, re-encodes frames from
 * targetTime onward as new H.264 NAL units (starting with an IDR keyframe),
 * and uses original data from the next keyframe onward.
 *
 * @param {object} parser - Parsed TS segment (TSParser output)
 * @param {number} targetStartTime - Start time in seconds (relative to segment)
 * @param {object} [options]
 * @param {number} [options.endTime] - End time in seconds (relative to segment)
 * @param {number} [options.bitrate] - Encoding bitrate (default: auto from source)
 * @returns {Promise<object>} { videoAUs, audioAUs, actualStartTime }
 */
export async function smartRender(parser, targetStartTime, options = {}) {
  if (!isSmartRenderSupported()) {
    return keyframeAccurateFallback(parser, targetStartTime, options);
  }

  const { endTime = Infinity } = options;
  const PTS = 90000;
  const targetPts = targetStartTime * PTS;
  const endPts = endTime * PTS;
  const videoAUs = parser.videoAccessUnits;
  const audioAUs = parser.audioAccessUnits;

  if (videoAUs.length === 0) {
    return { videoAUs: [], audioAUs: [], actualStartTime: targetStartTime };
  }

  // Find keyframe at or before targetTime
  let keyframeIdx = 0;
  for (let i = 0; i < videoAUs.length; i++) {
    if (videoAUs[i].pts > targetPts) break;
    if (_isKeyframe(videoAUs[i])) keyframeIdx = i;
  }

  // Find target frame (first frame at or after targetTime)
  let targetIdx = keyframeIdx;
  for (let i = keyframeIdx; i < videoAUs.length; i++) {
    if (videoAUs[i].pts >= targetPts) { targetIdx = i; break; }
  }

  // If target IS the keyframe, no smart rendering needed
  if (targetIdx === keyframeIdx) {
    return keyframeAccurateFallback(parser, targetStartTime, options);
  }

  // Find next keyframe after target
  let nextKeyframeIdx = videoAUs.length;
  for (let i = targetIdx + 1; i < videoAUs.length; i++) {
    if (_isKeyframe(videoAUs[i])) { nextKeyframeIdx = i; break; }
  }

  // Find end frame
  let endIdx = videoAUs.length;
  for (let i = 0; i < videoAUs.length; i++) {
    if (videoAUs[i].pts >= endPts) { endIdx = i; break; }
  }

  // Extract SPS/PPS for decoder configuration
  let sps = null, pps = null;
  for (const au of videoAUs) {
    for (const nal of au.nalUnits) {
      const t = nal[0] & 0x1F;
      if (t === 7 && !sps) sps = nal;
      if (t === 8 && !pps) pps = nal;
    }
    if (sps && pps) break;
  }
  if (!sps || !pps) {
    return keyframeAccurateFallback(parser, targetStartTime, options);
  }

  // Parse dimensions from SPS (simplified — just need width/height for encoder config)
  const { width, height } = _parseSPSDimensions(sps);

  // Estimate bitrate from the original segment
  let totalBytes = 0;
  for (const au of videoAUs) {
    for (const nal of au.nalUnits) totalBytes += nal.length;
  }
  const segDuration = videoAUs.length > 1
    ? (videoAUs[videoAUs.length - 1].pts - videoAUs[0].pts) / PTS
    : 1;
  const estimatedBitrate = options.bitrate || Math.round((totalBytes * 8) / segDuration);

  try {
    // ── Step 1: Decode preroll frames using VideoDecoder ──
    const decodedFrames = await _decodeFrames(videoAUs, keyframeIdx, Math.min(nextKeyframeIdx, endIdx), sps, pps, width, height);

    // ── Step 2: Re-encode from targetIdx onward using VideoEncoder ──
    const reEncodedNALs = await _encodeFrames(
      decodedFrames, targetIdx - keyframeIdx, Math.min(nextKeyframeIdx, endIdx) - keyframeIdx,
      width, height, estimatedBitrate
    );

    // ── Step 3: Build output access units ──
    const outputVideo = [];
    const targetPtsActual = videoAUs[targetIdx].pts;

    // Re-encoded frames (targetIdx to nextKeyframeIdx)
    for (let i = 0; i < reEncodedNALs.length; i++) {
      const srcIdx = targetIdx + i;
      if (srcIdx >= endIdx) break;
      outputVideo.push({
        nalUnits: i === 0
          ? [sps, pps, ...reEncodedNALs[i]] // First frame gets SPS/PPS
          : reEncodedNALs[i],
        pts: videoAUs[srcIdx].pts,
        dts: videoAUs[srcIdx].dts,
      });
    }

    // Original frames from next keyframe onward
    for (let i = nextKeyframeIdx; i < endIdx; i++) {
      outputVideo.push(videoAUs[i]);
    }

    // Clip audio to match
    const audioStartPts = targetPtsActual;
    const audioEndPts = endIdx < videoAUs.length ? videoAUs[endIdx - 1].pts + PTS : Infinity;
    const outputAudio = audioAUs.filter(au => au.pts >= audioStartPts && au.pts < audioEndPts);

    // Clean up decoded frames
    for (const frame of decodedFrames) {
      if (frame && typeof frame.close === 'function') frame.close();
    }

    return {
      videoAUs: outputVideo,
      audioAUs: outputAudio,
      actualStartTime: targetPtsActual / PTS,
      smartRenderedFrames: reEncodedNALs.length,
      originalFrames: Math.max(0, endIdx - nextKeyframeIdx),
    };
  } catch (e) {
    // WebCodecs failed — fall back to keyframe-accurate
    console.warn('Smart render failed, falling back to keyframe-accurate:', e.message);
    return keyframeAccurateFallback(parser, targetStartTime, options);
  }
}

// ── WebCodecs decode ──────────────────────────────────────

async function _decodeFrames(videoAUs, startIdx, endIdx, sps, pps, width, height) {
  const frames = [];
  let resolveFrame;

  const decoder = new VideoDecoder({
    output(frame) {
      frames.push(frame);
      if (resolveFrame) resolveFrame();
    },
    error(e) {
      console.error('VideoDecoder error:', e);
    },
  });

  // Build avcC description for decoder config
  const description = _buildAvcCDescription(sps, pps);

  decoder.configure({
    codec: 'avc1.' + _avcProfileString(sps),
    codedWidth: width,
    codedHeight: height,
    description,
    optimizeForLatency: true,
  });

  // Feed frames from keyframe to endIdx
  for (let i = startIdx; i < endIdx; i++) {
    const au = videoAUs[i];
    const isKey = _isKeyframe(au);

    // Convert NAL units to AVCC format (4-byte length prefix)
    const avccData = _nalUnitsToAVCC(au.nalUnits);

    const chunk = new EncodedVideoChunk({
      type: isKey ? 'key' : 'delta',
      timestamp: au.pts, // microseconds for WebCodecs? No, we use our PTS
      data: avccData,
    });

    const framePromise = new Promise(r => { resolveFrame = r; });
    decoder.decode(chunk);
    await framePromise;
  }

  await decoder.flush();
  decoder.close();

  return frames;
}

// ── WebCodecs encode ──────────────────────────────────────

async function _encodeFrames(decodedFrames, startOffset, endOffset, width, height, bitrate) {
  const encodedNALs = [];
  let resolveChunk;

  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      // Extract H.264 NAL units from the encoded chunk
      const buffer = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buffer);

      // The encoder output is in AVCC format — convert to NAL units
      const nals = _avccToNALUnits(buffer);
      encodedNALs.push(nals);
      if (resolveChunk) resolveChunk();
    },
    error(e) {
      console.error('VideoEncoder error:', e);
    },
  });

  encoder.configure({
    codec: 'avc1.640028', // High profile, level 4.0
    width,
    height,
    bitrate,
    framerate: 30,
    latencyMode: 'quality',
    avc: { format: 'annexb' }, // Get Annex B output (start codes)
  });

  for (let i = startOffset; i < Math.min(endOffset, decodedFrames.length); i++) {
    const frame = decodedFrames[i];
    if (!frame) continue;

    const chunkPromise = new Promise(r => { resolveChunk = r; });
    encoder.encode(frame, { keyFrame: i === startOffset }); // First frame = keyframe
    await chunkPromise;
  }

  await encoder.flush();
  encoder.close();

  return encodedNALs;
}

// ── Keyframe-accurate fallback ────────────────────────────

function keyframeAccurateFallback(parser, targetStartTime, options = {}) {
  const { endTime = Infinity } = options;
  const PTS = 90000;
  const targetPts = targetStartTime * PTS;
  const endPts = endTime * PTS;
  const videoAUs = parser.videoAccessUnits;
  const audioAUs = parser.audioAccessUnits;

  if (videoAUs.length === 0) {
    return { videoAUs: [], audioAUs: [], actualStartTime: targetStartTime };
  }

  // Find keyframe at or before targetTime
  let keyframeIdx = 0;
  for (let i = 0; i < videoAUs.length; i++) {
    if (videoAUs[i].pts > targetPts) break;
    if (_isKeyframe(videoAUs[i])) keyframeIdx = i;
  }

  // Find end
  let endIdx = videoAUs.length;
  for (let i = 0; i < videoAUs.length; i++) {
    if (videoAUs[i].pts >= endPts) { endIdx = i; break; }
  }

  const clippedVideo = videoAUs.slice(keyframeIdx, endIdx);
  const startPts = clippedVideo.length > 0 ? clippedVideo[0].pts : 0;
  const endVideoPts = endIdx < videoAUs.length ? videoAUs[endIdx - 1].pts + PTS : Infinity;
  const clippedAudio = audioAUs.filter(au => au.pts >= startPts && au.pts < endVideoPts);

  return {
    videoAUs: clippedVideo,
    audioAUs: clippedAudio,
    actualStartTime: startPts / PTS,
    smartRenderedFrames: 0,
    originalFrames: clippedVideo.length,
  };
}

// ── Helpers ───────────────────────────────────────────────

function _isKeyframe(au) {
  for (const nal of au.nalUnits) {
    if ((nal[0] & 0x1F) === 5) return true;
  }
  return false;
}

function _parseSPSDimensions(sps) {
  // Minimal SPS dimension parsing (reuses logic from muxers/mp4.js parseSPS)
  let width = 1920, height = 1080;
  if (!sps || sps.length < 4) return { width, height };

  try {
    let offset = 1;
    const profile = sps[offset++];
    offset += 2; // constraint flags + level

    let bitPos = offset * 8;
    const getBit = () => (sps[Math.floor(bitPos / 8)] >> (7 - (bitPos++ % 8))) & 1;
    const readUE = () => {
      let z = 0;
      while (bitPos < sps.length * 8 && getBit() === 0) z++;
      let v = (1 << z) - 1;
      for (let i = 0; i < z; i++) v += getBit() << (z - 1 - i);
      return v;
    };

    readUE(); // sps_id
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128].includes(profile)) {
      const cf = readUE(); if (cf === 3) getBit();
      readUE(); readUE(); getBit();
      if (getBit()) { for (let i = 0; i < (cf !== 3 ? 8 : 12); i++) { if (getBit()) { const s = i < 6 ? 16 : 64; let ls = 8, ns = 8; for (let j = 0; j < s; j++) { if (ns !== 0) { const ds = readUE(); // readSE actually
        ns = (ls + ds + 256) % 256; } ls = ns === 0 ? ls : ns; } } } }
    }
    readUE(); // log2_max_frame_num
    const pocType = readUE();
    if (pocType === 0) readUE();
    else if (pocType === 1) { getBit(); readUE(); readUE(); const n = readUE(); for (let i = 0; i < n; i++) readUE(); }
    readUE(); getBit(); // max_ref_frames, gaps

    const mbW = readUE() + 1;
    const mbH = readUE() + 1;
    const frameMbsOnly = getBit();
    if (!frameMbsOnly) getBit();
    getBit(); // direct_8x8

    let cropL = 0, cropR = 0, cropT = 0, cropB = 0;
    if (getBit()) { cropL = readUE(); cropR = readUE(); cropT = readUE(); cropB = readUE(); }

    width = mbW * 16 - (cropL + cropR) * 2;
    height = (2 - frameMbsOnly) * mbH * 16 - (cropT + cropB) * (frameMbsOnly ? 2 : 4);
  } catch (e) { /* use defaults */ }

  return { width, height };
}

function _avcProfileString(sps) {
  return [sps[1], sps[2], sps[3]].map(b => b.toString(16).padStart(2, '0')).join('');
}

function _buildAvcCDescription(sps, pps) {
  const data = new Uint8Array(11 + sps.length + pps.length);
  const view = new DataView(data.buffer);
  data[0] = 1; data[1] = sps[1]; data[2] = sps[2]; data[3] = sps[3];
  data[4] = 0xFF; data[5] = 0xE1;
  view.setUint16(6, sps.length); data.set(sps, 8);
  data[8 + sps.length] = 1;
  view.setUint16(9 + sps.length, pps.length);
  data.set(pps, 11 + sps.length);
  return data;
}

function _nalUnitsToAVCC(nalUnits) {
  // Filter out SPS/PPS/AUD/SEI — decoder config handles those
  const videoNals = nalUnits.filter(nal => {
    const t = nal[0] & 0x1F;
    return t === 1 || t === 5; // non-IDR or IDR slice
  });

  let totalSize = 0;
  for (const nal of videoNals) totalSize += 4 + nal.length;
  const result = new Uint8Array(totalSize);
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const nal of videoNals) {
    view.setUint32(offset, nal.length);
    result.set(nal, offset + 4);
    offset += 4 + nal.length;
  }
  return result;
}

function _avccToNALUnits(data) {
  // Parse Annex B format (start codes) or AVCC (length-prefixed)
  const nals = [];

  // Check for Annex B (0x00000001 or 0x000001)
  if (data.length >= 4 && data[0] === 0 && data[1] === 0) {
    let i = 0;
    while (i < data.length - 3) {
      // Find start code
      let scLen = 0;
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) scLen = 3;
      else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) scLen = 4;

      if (scLen > 0) {
        const nalStart = i + scLen;
        // Find next start code
        let nalEnd = data.length;
        for (let j = nalStart + 1; j < data.length - 2; j++) {
          if (data[j] === 0 && data[j + 1] === 0 && (data[j + 2] === 1 || (data[j + 2] === 0 && j + 3 < data.length && data[j + 3] === 1))) {
            nalEnd = j;
            break;
          }
        }
        if (nalEnd > nalStart) {
          nals.push(data.slice(nalStart, nalEnd));
        }
        i = nalEnd;
      } else {
        i++;
      }
    }
  } else {
    // AVCC format (4-byte length prefix)
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;
    while (offset + 4 < data.length) {
      const len = view.getUint32(offset);
      if (len > 0 && offset + 4 + len <= data.length) {
        nals.push(data.slice(offset + 4, offset + 4 + len));
      }
      offset += 4 + len;
    }
  }

  return nals;
}

export default smartRender;
