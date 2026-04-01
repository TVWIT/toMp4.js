/**
 * fMP4 Fragment Muxer
 *
 * Creates CMAF-compliant fMP4 init segments and media fragments
 * from parsed TS data (NAL units + AAC frames). Used by the HLS
 * clipper to produce frame-accurate fMP4/CMAF output.
 *
 * @module muxers/fmp4
 */

import { createBox } from '../fmp4/utils.js';
import { parseSPS } from './mp4.js';

// ── helpers ───────────────────────────────────────────────

function createFullBox(type, version, flags, ...payloads) {
  const header = new Uint8Array(4);
  header[0] = version;
  header[1] = (flags >> 16) & 0xFF;
  header[2] = (flags >> 8) & 0xFF;
  header[3] = flags & 0xFF;
  return createBox(type, header, ...payloads);
}

function strToBytes(s) {
  return new Uint8Array([...s].map(c => c.charCodeAt(0)));
}

// ── init segment ──────────────────────────────────────────

/**
 * Create a CMAF ftyp box.
 * @returns {Uint8Array}
 */
export function createCmafFtyp() {
  const data = new Uint8Array(16);
  // major brand: isom
  data.set(strToBytes('isom'), 0);
  // minor version: 0x200
  data[7] = 0x02;
  // compatible brands: isom, iso6
  data.set(strToBytes('isom'), 8);
  data.set(strToBytes('iso6'), 12);
  return createBox('ftyp', data);
}

/**
 * Build an avcC box from SPS and PPS NAL units.
 */
function buildAvcC(sps, pps) {
  const data = new Uint8Array(11 + sps.length + pps.length);
  const view = new DataView(data.buffer);
  data[0] = 1;
  data[1] = sps[1]; data[2] = sps[2]; data[3] = sps[3];
  data[4] = 0xFF; // lengthSizeMinusOne = 3 (4-byte NAL lengths)
  data[5] = 0xE1; // numSPS = 1
  view.setUint16(6, sps.length);
  data.set(sps, 8);
  data[8 + sps.length] = 1; // numPPS
  view.setUint16(9 + sps.length, pps.length);
  data.set(pps, 11 + sps.length);
  return createBox('avcC', data);
}

/**
 * Build an esds box for AAC audio.
 */
function buildEsds(sampleRate, channels) {
  const SAMPLE_RATE_INDEX = {
    96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5,
    24000: 6, 22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11, 7350: 12
  };
  const samplingFreqIndex = SAMPLE_RATE_INDEX[sampleRate] ?? 4;
  const audioConfig = ((2 << 11) | (samplingFreqIndex << 7) | (channels << 3)) & 0xFFFF;

  const data = new Uint8Array([
    0x00, 0x00, 0x00, 0x00,
    0x03, 0x19, 0x00, 0x02, 0x00,
    0x04, 0x11, 0x40, 0x15,
    0x00, 0x00, 0x00,
    0x00, 0x01, 0xF4, 0x00,
    0x00, 0x01, 0xF4, 0x00,
    0x05, 0x02,
    (audioConfig >> 8) & 0xFF, audioConfig & 0xFF,
    0x06, 0x01, 0x02
  ]);
  return createBox('esds', data);
}

/**
 * Create a CMAF init segment (ftyp + moov) from codec parameters.
 *
 * @param {object} codecInfo
 * @param {Uint8Array} codecInfo.sps - H.264 SPS NAL unit
 * @param {Uint8Array} codecInfo.pps - H.264 PPS NAL unit
 * @param {number} [codecInfo.audioSampleRate=48000]
 * @param {number} [codecInfo.audioChannels=2]
 * @param {boolean} [codecInfo.hasAudio=true]
 * @param {number} [codecInfo.videoTimescale=90000]
 * @param {number} [codecInfo.audioTimescale] - defaults to audioSampleRate
 * @returns {Uint8Array}
 */
export function createInitSegment(codecInfo) {
  const {
    sps, pps,
    audioSampleRate = 48000,
    audioChannels = 2,
    hasAudio = true,
    videoTimescale = 90000,
  } = codecInfo;
  const audioTimescale = codecInfo.audioTimescale || audioSampleRate;
  const { width, height } = parseSPS(sps);

  const VIDEO_TRACK_ID = 1;
  const AUDIO_TRACK_ID = 2;

  // ── mvhd ──
  const mvhdData = new Uint8Array(96);
  const mvhdView = new DataView(mvhdData.buffer);
  mvhdView.setUint32(8, 1000); // timescale
  mvhdView.setUint32(16, 0x00010000); // rate
  mvhdView.setUint16(20, 0x0100); // volume
  mvhdView.setUint32(32, 0x00010000); // matrix
  mvhdView.setUint32(48, 0x00010000);
  mvhdView.setUint32(64, 0x40000000);
  mvhdView.setUint32(92, hasAudio ? 3 : 2); // next_track_ID
  const mvhd = createFullBox('mvhd', 0, 0, mvhdData);

  // ── video trak ──
  const videoTrak = buildInitTrak(VIDEO_TRACK_ID, 'vide', videoTimescale, width, height, () => {
    const avcC = buildAvcC(sps, pps);
    const avc1Data = new Uint8Array(78 + avcC.byteLength);
    const v = new DataView(avc1Data.buffer);
    v.setUint16(6, 1); v.setUint16(24, width); v.setUint16(26, height);
    v.setUint32(28, 0x00480000); v.setUint32(32, 0x00480000);
    v.setUint16(40, 1); v.setUint16(74, 0x0018); v.setInt16(76, -1);
    avc1Data.set(avcC, 78);
    return createBox('avc1', avc1Data);
  });

  // ── audio trak ──
  let audioTrak = null;
  if (hasAudio) {
    audioTrak = buildInitTrak(AUDIO_TRACK_ID, 'soun', audioTimescale, 0, 0, () => {
      const esds = buildEsds(audioSampleRate, audioChannels);
      const mp4aData = new Uint8Array(28 + esds.byteLength);
      const v = new DataView(mp4aData.buffer);
      v.setUint16(6, 1); v.setUint16(16, audioChannels); v.setUint16(18, 16);
      v.setUint32(24, audioTimescale << 16);
      mp4aData.set(esds, 28);
      return createBox('mp4a', mp4aData);
    });
  }

  // ── mvex (track extends for fragmented mode) ──
  const mvexParts = [buildTrex(VIDEO_TRACK_ID)];
  if (hasAudio) mvexParts.push(buildTrex(AUDIO_TRACK_ID));
  const mvex = createBox('mvex', ...mvexParts);

  // ── assemble moov ──
  const moovParts = [mvhd, videoTrak];
  if (audioTrak) moovParts.push(audioTrak);
  moovParts.push(mvex);
  const moov = createBox('moov', ...moovParts);

  const ftyp = createCmafFtyp();
  const result = new Uint8Array(ftyp.byteLength + moov.byteLength);
  result.set(ftyp, 0);
  result.set(moov, ftyp.byteLength);
  return result;
}

/**
 * Build a trak box for the init segment (empty sample tables).
 */
function buildInitTrak(trackId, handlerType, timescale, width, height, buildSampleEntry) {
  // tkhd
  const tkhdData = new Uint8Array(80);
  const tkhdView = new DataView(tkhdData.buffer);
  tkhdView.setUint32(8, trackId);
  tkhdView.setUint32(36, 0x00010000); // matrix
  tkhdView.setUint32(52, 0x00010000);
  tkhdView.setUint32(68, 0x40000000);
  if (width && height) {
    tkhdView.setUint32(72, width << 16);
    tkhdView.setUint32(76, height << 16);
  }
  if (handlerType === 'soun') tkhdView.setUint16(32, 0x0100); // volume
  const tkhd = createFullBox('tkhd', 0, 3, tkhdData);

  // mdhd
  const mdhdData = new Uint8Array(20);
  new DataView(mdhdData.buffer).setUint32(8, timescale);
  mdhdData[16] = 0x55; mdhdData[17] = 0xC4; // language: und
  const mdhd = createFullBox('mdhd', 0, 0, mdhdData);

  // hdlr
  const hdlrData = new Uint8Array(21);
  hdlrData.set(strToBytes(handlerType), 4);
  const hdlr = createFullBox('hdlr', 0, 0, hdlrData);

  // xmhd (vmhd or smhd)
  const xmhd = handlerType === 'vide'
    ? createFullBox('vmhd', 0, 1, new Uint8Array(8))
    : createFullBox('smhd', 0, 0, new Uint8Array(4));

  // dinf
  const urlBox = createFullBox('url ', 0, 1, new Uint8Array(0));
  const dref = createFullBox('dref', 0, 0, new Uint8Array([0, 0, 0, 1]), urlBox);
  const dinf = createBox('dinf', dref);

  // stbl (empty sample tables for init segment)
  const sampleEntry = buildSampleEntry();
  const stsdHeader = new Uint8Array(4);
  new DataView(stsdHeader.buffer).setUint32(0, 1);
  const stsd = createFullBox('stsd', 0, 0, stsdHeader, sampleEntry);

  const emptyStts = createFullBox('stts', 0, 0, new Uint8Array(4));
  const emptyStsc = createFullBox('stsc', 0, 0, new Uint8Array(4));
  const emptyStsz = createFullBox('stsz', 0, 0, new Uint8Array(8));
  const emptyStco = createFullBox('stco', 0, 0, new Uint8Array(4));
  const stbl = createBox('stbl', stsd, emptyStts, emptyStsc, emptyStsz, emptyStco);

  const minf = createBox('minf', xmhd, dinf, stbl);
  const mdia = createBox('mdia', mdhd, hdlr, minf);
  return createBox('trak', tkhd, mdia);
}

/**
 * Build a trex (track extends) box for mvex.
 */
function buildTrex(trackId) {
  const data = new Uint8Array(20);
  const view = new DataView(data.buffer);
  view.setUint32(0, trackId); // track_ID
  view.setUint32(4, 1);       // default_sample_description_index
  return createFullBox('trex', 0, 0, data);
}

// ── media fragments ───────────────────────────────────────

/**
 * Create an fMP4 media fragment (moof + mdat) from video and audio samples.
 *
 * Video samples: array of { nalUnits: Uint8Array[], pts: number, dts: number }
 *   (pts/dts in 90kHz ticks, same as TSParser output)
 *
 * Audio samples: array of { data: Uint8Array, pts: number }
 *   (pts in 90kHz ticks)
 *
 * @param {object} opts
 * @param {Array} opts.videoSamples - Video access units
 * @param {Array} [opts.audioSamples] - Audio access units
 * @param {number} opts.sequenceNumber - Fragment sequence (1-based)
 * @param {number} opts.videoTimescale - Video timescale (typically 90000)
 * @param {number} [opts.audioTimescale=48000] - Audio timescale
 * @param {number} [opts.videoBaseTime=0] - Video base decode time (in videoTimescale ticks)
 * @param {number} [opts.audioBaseTime=0] - Audio base decode time (in audioTimescale ticks)
 * @param {number} [opts.audioSampleDuration=1024] - AAC frame duration in audio timescale
 * @returns {Uint8Array} moof + mdat
 */
export function createFragment(opts) {
  const {
    videoSamples,
    audioSamples = [],
    sequenceNumber = 1,
    videoTimescale = 90000,
    audioTimescale = 48000,
    videoBaseTime = 0,
    audioBaseTime = 0,
    audioSampleDuration = 1024,
  } = opts;

  const VIDEO_TRACK_ID = 1;
  const AUDIO_TRACK_ID = 2;

  // ── build video sample data (AVCC format) + metadata ──
  const videoChunks = [];
  const videoMeta = [];
  for (let i = 0; i < videoSamples.length; i++) {
    const au = videoSamples[i];
    let sampleSize = 0;
    const parts = [];
    for (const nalUnit of au.nalUnits) {
      const prefixed = new Uint8Array(4 + nalUnit.length);
      new DataView(prefixed.buffer).setUint32(0, nalUnit.length);
      prefixed.set(nalUnit, 4);
      parts.push(prefixed);
      sampleSize += prefixed.length;
    }
    videoChunks.push(parts);

    // Detect keyframe (IDR NAL type 5)
    let isKeyframe = false;
    for (const nalUnit of au.nalUnits) {
      if ((nalUnit[0] & 0x1F) === 5) { isKeyframe = true; break; }
    }

    const duration = i < videoSamples.length - 1
      ? videoSamples[i + 1].dts - au.dts
      : (videoMeta.length > 0 ? videoMeta[videoMeta.length - 1].duration : 3003);
    const compositionTimeOffset = au.pts - au.dts;

    videoMeta.push({
      size: sampleSize,
      duration,
      flags: isKeyframe ? 0x02000000 : 0x01010000,
      compositionTimeOffset,
    });
  }

  // ── build audio sample data + metadata ──
  const audioChunks = [];
  const audioMeta = [];
  for (const frame of audioSamples) {
    audioChunks.push(frame.data);
    audioMeta.push({ size: frame.data.length });
  }

  // ── compute total mdat content sizes ──
  let videoDataSize = 0;
  for (const parts of videoChunks) for (const p of parts) videoDataSize += p.length;
  let audioDataSize = 0;
  for (const d of audioChunks) audioDataSize += d.length;

  // ── build trafs ──
  // We need to know the moof size to set trun data_offset. Two-pass:
  // 1. Build trafs with placeholder data_offset
  // 2. Measure moof size
  // 3. Patch data_offsets

  const videoTraf = buildTraf(VIDEO_TRACK_ID, videoBaseTime, videoMeta, true);
  const audioTraf = audioMeta.length > 0
    ? buildTraf(AUDIO_TRACK_ID, audioBaseTime, audioMeta, false, audioSampleDuration)
    : null;

  // mfhd
  const mfhdData = new Uint8Array(4);
  new DataView(mfhdData.buffer).setUint32(0, sequenceNumber);
  const mfhd = createFullBox('mfhd', 0, 0, mfhdData);

  // Assemble moof (with placeholder offsets)
  const moofParts = [mfhd, videoTraf];
  if (audioTraf) moofParts.push(audioTraf);
  const moof = createBox('moof', ...moofParts);

  // ── build mdat ──
  const mdatContentSize = videoDataSize + audioDataSize;
  const mdatHeaderSize = 8;
  const mdatTotal = mdatHeaderSize + mdatContentSize;
  const mdat = new Uint8Array(mdatTotal);
  new DataView(mdat.buffer).setUint32(0, mdatTotal);
  mdat[4] = 'm'.charCodeAt(0); mdat[5] = 'd'.charCodeAt(0);
  mdat[6] = 'a'.charCodeAt(0); mdat[7] = 't'.charCodeAt(0);

  let writeOffset = mdatHeaderSize;
  for (const parts of videoChunks) {
    for (const p of parts) { mdat.set(p, writeOffset); writeOffset += p.length; }
  }
  for (const d of audioChunks) { mdat.set(d, writeOffset); writeOffset += d.length; }

  // ── patch trun data_offsets in moof ──
  // data_offset = byte distance from moof start to the track's data in mdat
  const videoDataOffset = moof.byteLength + mdatHeaderSize;
  const audioDataOffset = videoDataOffset + videoDataSize;
  patchTrunDataOffset(moof, VIDEO_TRACK_ID, videoDataOffset);
  if (audioTraf) patchTrunDataOffset(moof, AUDIO_TRACK_ID, audioDataOffset);

  // ── combine ──
  const result = new Uint8Array(moof.byteLength + mdat.byteLength);
  result.set(moof, 0);
  result.set(mdat, moof.byteLength);
  return result;
}

/**
 * Build a traf box for one track.
 */
function buildTraf(trackId, baseDecodeTime, sampleMeta, isVideo, defaultDuration = 0) {
  // tfhd: track_id only, no defaults in header
  const tfhdFlags = 0x020000; // default-base-is-moof
  const tfhdData = new Uint8Array(4);
  new DataView(tfhdData.buffer).setUint32(0, trackId);
  const tfhd = createFullBox('tfhd', 0, tfhdFlags, tfhdData);

  // tfdt: base media decode time
  const tfdtData = new Uint8Array(8);
  const tfdtView = new DataView(tfdtData.buffer);
  // Use version 1 (64-bit) for large timestamps
  tfdtView.setUint32(0, (baseDecodeTime / 0x100000000) >>> 0);
  tfdtView.setUint32(4, baseDecodeTime >>> 0);
  const tfdt = createFullBox('tfdt', 1, 0, tfdtData);

  // trun
  const trun = isVideo
    ? buildVideoTrun(sampleMeta)
    : buildAudioTrun(sampleMeta, defaultDuration);

  return createBox('traf', tfhd, tfdt, trun);
}

/**
 * Build a video trun with per-sample duration, size, flags, CTO.
 */
function buildVideoTrun(samples) {
  // flags: data-offset-present | duration | size | flags | composition-time-offset
  const trunFlags = 0x000001 | 0x000100 | 0x000200 | 0x000400 | 0x000800;
  const headerSize = 8; // sample_count(4) + data_offset(4)
  const perSampleSize = 16; // duration(4) + size(4) + flags(4) + CTO(4)
  const payload = new Uint8Array(headerSize + samples.length * perSampleSize);
  const view = new DataView(payload.buffer);

  view.setUint32(0, samples.length); // sample_count
  view.setInt32(4, 0); // data_offset (placeholder, patched later)

  let offset = 8;
  for (const sample of samples) {
    view.setUint32(offset, sample.duration); offset += 4;
    view.setUint32(offset, sample.size); offset += 4;
    view.setUint32(offset, sample.flags); offset += 4;
    view.setInt32(offset, sample.compositionTimeOffset); offset += 4;
  }

  return createFullBox('trun', 0, trunFlags, payload);
}

/**
 * Build an audio trun with per-sample size (duration via default).
 */
function buildAudioTrun(samples, defaultDuration) {
  // flags: data-offset-present | size
  const trunFlags = 0x000001 | 0x000100 | 0x000200;
  const headerSize = 8;
  const perSampleSize = 8; // duration(4) + size(4)
  const payload = new Uint8Array(headerSize + samples.length * perSampleSize);
  const view = new DataView(payload.buffer);

  view.setUint32(0, samples.length);
  view.setInt32(4, 0); // data_offset placeholder

  let offset = 8;
  for (const sample of samples) {
    view.setUint32(offset, defaultDuration); offset += 4;
    view.setUint32(offset, sample.size); offset += 4;
  }

  return createFullBox('trun', 0, trunFlags, payload);
}

/**
 * Patch the data_offset in a trun box within a moof.
 * Scans the moof for a traf with the given trackId, then patches its trun.
 */
function patchTrunDataOffset(moof, targetTrackId, dataOffset) {
  const view = new DataView(moof.buffer, moof.byteOffset, moof.byteLength);
  let pos = 8; // skip moof header

  while (pos + 8 < moof.byteLength) {
    const boxSize = view.getUint32(pos);
    const boxType = String.fromCharCode(moof[pos + 4], moof[pos + 5], moof[pos + 6], moof[pos + 7]);
    if (boxSize < 8) break;

    if (boxType === 'traf') {
      // Find tfhd to check track ID
      let innerPos = pos + 8;
      let foundTrack = false;
      while (innerPos + 8 < pos + boxSize) {
        const innerSize = view.getUint32(innerPos);
        const innerType = String.fromCharCode(moof[innerPos + 4], moof[innerPos + 5], moof[innerPos + 6], moof[innerPos + 7]);
        if (innerSize < 8) break;

        if (innerType === 'tfhd') {
          const trackId = view.getUint32(innerPos + 12);
          foundTrack = (trackId === targetTrackId);
        }

        if (innerType === 'trun' && foundTrack) {
          // data_offset is at fullbox header (12) + sample_count (4) = offset 16
          // But trun has: box header (8) + version/flags (4) + sample_count (4) + data_offset (4)
          // So data_offset is at innerPos + 16
          view.setInt32(innerPos + 16, dataOffset);
          return;
        }

        innerPos += innerSize;
      }
    }

    pos += boxSize;
  }
}

export default { createInitSegment, createFragment, createCmafFtyp };
