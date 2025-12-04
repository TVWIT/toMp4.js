/**
 * Browser-only transcoding using WebCodecs API
 * 
 * This module provides hardware-accelerated video transcoding in the browser.
 * It uses WebCodecs for decoding and encoding, achieving faster-than-realtime performance.
 * 
 * Supports both MPEG-TS and MP4 input files.
 * 
 * @example
 * import { transcode } from 'tomp4';
 * 
 * const result = await transcode(videoData, {
 *   width: 1280,
 *   height: 720,
 *   bitrate: 2_000_000,
 *   onProgress: (msg) => console.log(msg)
 * });
 * 
 * @module transcode
 * @browser-only
 */

import { TSParser } from './parsers/mpegts.js';
import { TSMuxer } from './muxers/mpegts.js';

// Re-export TSMuxer for convenience
export { TSMuxer };

// ============================================
// Format Detection
// ============================================

function isMpegTs(data) {
  if (data.length < 4) return false;
  if (data[0] === 0x47) return true;
  for (let i = 0; i < Math.min(188, data.length); i++) {
    if (data[i] === 0x47 && i + 188 < data.length && data[i + 188] === 0x47) return true;
  }
  return false;
}

function isMp4(data) {
  if (data.length < 8) return false;
  const type = String.fromCharCode(data[4], data[5], data[6], data[7]);
  return type === 'ftyp';
}

// ============================================
// MP4 Parser (for transcoding input)
// ============================================

/**
 * Simple MP4 parser that extracts video/audio samples for transcoding
 */
class MP4Parser {
  constructor() {
    this.videoAccessUnits = [];
    this.audioAccessUnits = [];
    this.videoWidth = null;
    this.videoHeight = null;
    this.audioSampleRate = null;
    this.audioChannels = null;
    this.sps = null;
    this.pps = null;
  }
  
  parse(data) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    
    // Find moov and mdat boxes
    let offset = 0;
    let moov = null, mdat = null, mdatOffset = 0;
    
    while (offset + 8 <= data.length) {
      const size = this.view.getUint32(offset);
      const type = this.readString(offset + 4, 4);
      
      if (size < 8) break;
      
      if (type === 'moov') {
        moov = { offset, size };
      } else if (type === 'mdat') {
        mdat = { offset, size };
        mdatOffset = offset + 8;
      }
      
      offset += size;
    }
    
    if (!moov) throw new Error('No moov box found in MP4');
    if (!mdat) throw new Error('No mdat box found in MP4');
    
    // Parse moov to get track info
    this.parseMoov(moov.offset + 8, moov.offset + moov.size, mdatOffset);
  }
  
  readString(offset, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.data[offset + i]);
    return s;
  }
  
  readUint32(offset) {
    return this.view.getUint32(offset);
  }
  
  readUint16(offset) {
    return this.view.getUint16(offset);
  }
  
  parseMoov(start, end, mdatOffset) {
    let offset = start;
    let timescale = 1000;
    
    while (offset + 8 <= end) {
      const size = this.readUint32(offset);
      const type = this.readString(offset + 4, 4);
      
      if (size < 8) break;
      
      if (type === 'mvhd') {
        // Movie header - get timescale
        const version = this.data[offset + 8];
        timescale = version === 1 
          ? this.readUint32(offset + 28) 
          : this.readUint32(offset + 20);
      } else if (type === 'trak') {
        this.parseTrak(offset + 8, offset + size, mdatOffset);
      }
      
      offset += size;
    }
  }
  
  parseTrak(start, end, mdatOffset) {
    let offset = start;
    let trackType = null;
    let mediaTimescale = 1000;
    let stbl = null;
    
    while (offset + 8 <= end) {
      const size = this.readUint32(offset);
      const type = this.readString(offset + 4, 4);
      
      if (size < 8) break;
      
      if (type === 'mdia') {
        // Parse mdia to find handler type and stbl
        let mdiaOff = offset + 8;
        const mdiaEnd = offset + size;
        
        while (mdiaOff + 8 <= mdiaEnd) {
          const mSize = this.readUint32(mdiaOff);
          const mType = this.readString(mdiaOff + 4, 4);
          
          if (mSize < 8) break;
          
          if (mType === 'mdhd') {
            const version = this.data[mdiaOff + 8];
            mediaTimescale = version === 1
              ? this.readUint32(mdiaOff + 28)
              : this.readUint32(mdiaOff + 20);
          } else if (mType === 'hdlr') {
            trackType = this.readString(mdiaOff + 16, 4);
          } else if (mType === 'minf') {
            // Find stbl in minf
            let minfOff = mdiaOff + 8;
            const minfEnd = mdiaOff + mSize;
            
            while (minfOff + 8 <= minfEnd) {
              const sSize = this.readUint32(minfOff);
              const sType = this.readString(minfOff + 4, 4);
              
              if (sSize < 8) break;
              
              if (sType === 'stbl') {
                stbl = { offset: minfOff + 8, end: minfOff + sSize };
              }
              
              minfOff += sSize;
            }
          }
          
          mdiaOff += mSize;
        }
      }
      
      offset += size;
    }
    
    if (stbl && trackType) {
      this.parseStbl(stbl.offset, stbl.end, trackType, mediaTimescale, mdatOffset);
    }
  }
  
  parseStbl(start, end, trackType, timescale, mdatOffset) {
    let offset = start;
    
    // Sample table data
    let stsd = null;
    let stsz = null;   // sample sizes
    let stco = null;   // chunk offsets
    let stsc = null;   // sample-to-chunk
    let stts = null;   // time-to-sample
    let ctts = null;   // composition time offsets
    let stss = null;   // sync samples (keyframes)
    
    while (offset + 8 <= end) {
      const size = this.readUint32(offset);
      const type = this.readString(offset + 4, 4);
      
      if (size < 8) break;
      
      if (type === 'stsd') stsd = { offset: offset + 8, size: size - 8 };
      else if (type === 'stsz') stsz = { offset: offset + 8, size: size - 8 };
      else if (type === 'stco') stco = { offset: offset + 8, size: size - 8, is64: false };
      else if (type === 'co64') stco = { offset: offset + 8, size: size - 8, is64: true };
      else if (type === 'stsc') stsc = { offset: offset + 8, size: size - 8 };
      else if (type === 'stts') stts = { offset: offset + 8, size: size - 8 };
      else if (type === 'ctts') ctts = { offset: offset + 8, size: size - 8 };
      else if (type === 'stss') stss = { offset: offset + 8, size: size - 8 };
      
      offset += size;
    }
    
    if (!stsd || !stsz || !stco || !stsc || !stts) return;
    
    // Parse sample description for codec info
    if (trackType === 'vide') {
      this.parseVideoStsd(stsd.offset, stsd.size);
    } else if (trackType === 'soun') {
      this.parseAudioStsd(stsd.offset, stsd.size);
    }
    
    // Build sample list
    const samples = this.buildSampleList(stsz, stco, stsc, stts, ctts, stss, timescale);
    
    // Extract samples from mdat
    if (trackType === 'vide') {
      this.extractVideoSamples(samples);
    } else if (trackType === 'soun') {
      this.extractAudioSamples(samples);
    }
  }
  
  parseVideoStsd(offset, size) {
    // Skip version/flags and entry count
    const entryCount = this.readUint32(offset + 4);
    if (entryCount < 1) return;
    
    let off = offset + 8;
    const entrySize = this.readUint32(off);
    const codec = this.readString(off + 4, 4);
    
    // Visual sample entry: skip to width/height
    this.videoWidth = this.readUint16(off + 32);
    this.videoHeight = this.readUint16(off + 34);
    
    // Find avcC box
    let boxOff = off + 86; // Skip visual sample entry header
    const boxEnd = off + entrySize;
    
    while (boxOff + 8 <= boxEnd) {
      const boxSize = this.readUint32(boxOff);
      const boxType = this.readString(boxOff + 4, 4);
      
      if (boxSize < 8) break;
      
      if (boxType === 'avcC') {
        this.parseAvcC(boxOff + 8, boxSize - 8);
        break;
      }
      
      boxOff += boxSize;
    }
  }
  
  parseAvcC(offset, size) {
    // avcC structure
    const configVersion = this.data[offset];
    const avcProfile = this.data[offset + 1];
    const profileCompat = this.data[offset + 2];
    const avcLevel = this.data[offset + 3];
    const nalLengthSize = (this.data[offset + 4] & 0x03) + 1;
    
    // SPS
    const numSps = this.data[offset + 5] & 0x1f;
    let off = offset + 6;
    
    if (numSps > 0) {
      const spsLen = this.readUint16(off);
      this.sps = this.data.slice(off + 2, off + 2 + spsLen);
      off += 2 + spsLen;
    }
    
    // PPS
    const numPps = this.data[off];
    off++;
    
    if (numPps > 0) {
      const ppsLen = this.readUint16(off);
      this.pps = this.data.slice(off + 2, off + 2 + ppsLen);
    }
  }
  
  parseAudioStsd(offset, size) {
    // Skip version/flags and entry count
    const entryCount = this.readUint32(offset + 4);
    if (entryCount < 1) return;
    
    let off = offset + 8;
    const entrySize = this.readUint32(off);
    const codec = this.readString(off + 4, 4);
    
    // Audio sample entry
    this.audioChannels = this.readUint16(off + 24);
    this.audioSampleRate = this.readUint32(off + 32) >> 16;
  }
  
  buildSampleList(stsz, stco, stsc, stts, ctts, stss, timescale) {
    const samples = [];
    
    // Parse sample sizes
    const defaultSize = this.readUint32(stsz.offset + 4);
    const sampleCount = this.readUint32(stsz.offset + 8);
    const sizes = [];
    
    if (defaultSize === 0) {
      for (let i = 0; i < sampleCount; i++) {
        sizes.push(this.readUint32(stsz.offset + 12 + i * 4));
      }
    } else {
      for (let i = 0; i < sampleCount; i++) sizes.push(defaultSize);
    }
    
    // Parse chunk offsets
    const chunkCount = this.readUint32(stco.offset + 4);
    const chunkOffsets = [];
    
    for (let i = 0; i < chunkCount; i++) {
      if (stco.is64) {
        // 64-bit offsets
        const hi = this.readUint32(stco.offset + 8 + i * 8);
        const lo = this.readUint32(stco.offset + 12 + i * 8);
        chunkOffsets.push(hi * 0x100000000 + lo);
      } else {
        chunkOffsets.push(this.readUint32(stco.offset + 8 + i * 4));
      }
    }
    
    // Parse sample-to-chunk
    const stscEntryCount = this.readUint32(stsc.offset + 4);
    const stscEntries = [];
    
    for (let i = 0; i < stscEntryCount; i++) {
      stscEntries.push({
        firstChunk: this.readUint32(stsc.offset + 8 + i * 12),
        samplesPerChunk: this.readUint32(stsc.offset + 12 + i * 12),
        sampleDescIdx: this.readUint32(stsc.offset + 16 + i * 12)
      });
    }
    
    // Parse time-to-sample
    const sttsEntryCount = this.readUint32(stts.offset + 4);
    const sttsEntries = [];
    
    for (let i = 0; i < sttsEntryCount; i++) {
      sttsEntries.push({
        count: this.readUint32(stts.offset + 8 + i * 8),
        delta: this.readUint32(stts.offset + 12 + i * 8)
      });
    }
    
    // Parse composition time offsets (optional)
    const cttsOffsets = [];
    if (ctts) {
      const cttsEntryCount = this.readUint32(ctts.offset + 4);
      let sampleIdx = 0;
      
      for (let i = 0; i < cttsEntryCount; i++) {
        const count = this.readUint32(ctts.offset + 8 + i * 8);
        const offset = this.view.getInt32(ctts.offset + 12 + i * 8);
        
        for (let j = 0; j < count; j++) {
          cttsOffsets[sampleIdx++] = offset;
        }
      }
    }
    
    // Parse sync samples (optional)
    const syncSamples = new Set();
    if (stss) {
      const stssEntryCount = this.readUint32(stss.offset + 4);
      for (let i = 0; i < stssEntryCount; i++) {
        syncSamples.add(this.readUint32(stss.offset + 8 + i * 4) - 1); // 0-indexed
      }
    }
    
    // Build sample offsets from chunk info
    const sampleOffsets = [];
    let sampleIdx = 0;
    let stscIdx = 0;
    
    for (let chunkIdx = 0; chunkIdx < chunkCount; chunkIdx++) {
      // Find which stsc entry applies to this chunk
      while (stscIdx + 1 < stscEntries.length && 
             stscEntries[stscIdx + 1].firstChunk <= chunkIdx + 1) {
        stscIdx++;
      }
      
      const samplesInChunk = stscEntries[stscIdx].samplesPerChunk;
      let chunkOffset = chunkOffsets[chunkIdx];
      
      for (let i = 0; i < samplesInChunk && sampleIdx < sampleCount; i++) {
        sampleOffsets.push(chunkOffset);
        chunkOffset += sizes[sampleIdx];
        sampleIdx++;
      }
    }
    
    // Build final sample list with timestamps
    let dts = 0;
    let sttsIdx = 0;
    let sttsRemaining = sttsEntries[0]?.count || 0;
    
    for (let i = 0; i < sampleCount; i++) {
      const cts = cttsOffsets[i] || 0;
      const pts = dts + cts;
      
      samples.push({
        offset: sampleOffsets[i],
        size: sizes[i],
        pts: Math.round(pts / timescale * 90000), // Convert to 90kHz
        dts: Math.round(dts / timescale * 90000),
        isKey: stss ? syncSamples.has(i) : (i === 0) // If no stss, assume first frame is key
      });
      
      // Advance DTS
      if (sttsIdx < sttsEntries.length) {
        dts += sttsEntries[sttsIdx].delta;
        sttsRemaining--;
        
        if (sttsRemaining === 0 && sttsIdx + 1 < sttsEntries.length) {
          sttsIdx++;
          sttsRemaining = sttsEntries[sttsIdx].count;
        }
      }
    }
    
    return samples;
  }
  
  extractVideoSamples(samples) {
    for (const sample of samples) {
      // Read sample data and parse NAL units
      const sampleData = this.data.slice(sample.offset, sample.offset + sample.size);
      const nalUnits = this.parseAvccNalUnits(sampleData);
      
      if (nalUnits.length > 0) {
        this.videoAccessUnits.push({
          pts: sample.pts,
          dts: sample.dts,
          isKey: sample.isKey,
          nalUnits
        });
      }
    }
  }
  
  parseAvccNalUnits(data) {
    // AVCC format: 4-byte length prefix (usually) followed by NAL unit
    const nalUnits = [];
    let offset = 0;
    
    while (offset + 4 <= data.length) {
      const len = (data[offset] << 24) | (data[offset + 1] << 16) | 
                  (data[offset + 2] << 8) | data[offset + 3];
      
      if (len <= 0 || offset + 4 + len > data.length) break;
      
      nalUnits.push(data.slice(offset + 4, offset + 4 + len));
      offset += 4 + len;
    }
    
    return nalUnits;
  }
  
  extractAudioSamples(samples) {
    for (const sample of samples) {
      const sampleData = this.data.slice(sample.offset, sample.offset + sample.size);
      
      this.audioAccessUnits.push({
        pts: sample.pts,
        data: sampleData
      });
    }
  }
  
  finalize() {
    // Nothing needed - parsing is synchronous
  }
}

// ============================================
// WebCodecs Support Check
// ============================================

/**
 * Check if WebCodecs is available
 * @returns {boolean}
 */
export function isWebCodecsSupported() {
  return typeof VideoDecoder !== 'undefined' && 
         typeof VideoEncoder !== 'undefined' &&
         typeof VideoFrame !== 'undefined' &&
         typeof EncodedVideoChunk !== 'undefined';
}

/**
 * Throw if WebCodecs not available
 */
function requireWebCodecs() {
  if (!isWebCodecsSupported()) {
    throw new Error('WebCodecs API not available. This feature requires a modern browser (Chrome 94+, Edge 94+, or Safari 16.4+).');
  }
}

// ============================================
// Utility Functions
// ============================================

function concat(arrays) {
  const len = arrays.reduce((s, a) => s + a.length, 0);
  const r = new Uint8Array(len);
  let o = 0;
  for (const a of arrays) { r.set(a, o); o += a.length; }
  return r;
}

function createAvcC(sps, pps) {
  return new Uint8Array([
    0x01, sps[1], sps[2], sps[3], 0xff, 0xe1,
    (sps.length >> 8) & 0xff, sps.length & 0xff, ...sps,
    0x01, (pps.length >> 8) & 0xff, pps.length & 0xff, ...pps
  ]);
}

// ============================================
// Main Transcode Function
// ============================================

/**
 * Transcode video using WebCodecs (browser-only)
 * 
 * Supports both MPEG-TS and MP4 input files.
 * 
 * @param {Uint8Array} data - Input video data (MPEG-TS or MP4)
 * @param {Object} [options] - Transcode options
 * @param {number} [options.width] - Output width (default: same as input)
 * @param {number} [options.height] - Output height (default: same as input)
 * @param {number} [options.bitrate=1_000_000] - Output bitrate in bps
 * @param {number} [options.keyFrameInterval=30] - Keyframe interval in frames
 * @param {Function} [options.onProgress] - Progress callback (message: string)
 * @returns {Promise<Uint8Array>} - Transcoded MPEG-TS data
 * 
 * @example
 * const output = await transcode(videoData, {
 *   width: 640,
 *   height: 360,
 *   bitrate: 1_000_000,
 *   onProgress: msg => console.log(msg)
 * });
 */
export async function transcode(data, options = {}) {
  requireWebCodecs();
  
  const log = options.onProgress || (() => {});
  const {
    bitrate = 1_000_000,
    keyFrameInterval = 30
  } = options;
  
  // Detect input format and parse
  let parser;
  let sps = null, pps = null;
  
  if (isMp4(data)) {
    log('Parsing input MP4...');
    parser = new MP4Parser();
    parser.parse(data);
    parser.finalize();
    
    // Get SPS/PPS directly from MP4 parser
    sps = parser.sps;
    pps = parser.pps;
  } else if (isMpegTs(data)) {
    log('Parsing input MPEG-TS...');
    parser = new TSParser();
    parser.parse(data);
    parser.finalize();
    
    // Find SPS/PPS in NAL units
    for (const au of parser.videoAccessUnits) {
      for (const nal of au.nalUnits) {
        const t = nal[0] & 0x1f;
        if (t === 7 && !sps) sps = nal;
        if (t === 8 && !pps) pps = nal;
      }
      if (sps && pps) break;
    }
  } else {
    throw new Error('Unsupported input format. Expected MPEG-TS or MP4.');
  }
  
  if (!parser.videoAccessUnits || parser.videoAccessUnits.length === 0) {
    throw new Error('No video found in input');
  }
  
  log(`Found ${parser.videoAccessUnits.length} video frames`);
  
  // Check for audio
  const hasAudio = parser.audioAccessUnits && parser.audioAccessUnits.length > 0;
  if (hasAudio) {
    log(`Found ${parser.audioAccessUnits.length} audio frames (will passthrough)`);
  }
  
  if (!sps || !pps) {
    throw new Error('No SPS/PPS found in input');
  }
  
  // Parse source dimensions from SPS (simplified)
  const srcW = parser.videoWidth || 1920;
  const srcH = parser.videoHeight || 1080;
  const outW = options.width || srcW;
  const outH = options.height || srcH;
  
  const codecStr = `avc1.${sps[1].toString(16).padStart(2, '0')}${sps[2].toString(16).padStart(2, '0')}${sps[3].toString(16).padStart(2, '0')}`;
  log(`Source: ${codecStr}, ${srcW}×${srcH}`);
  log(`Output: ${outW}×${outH} @ ${(bitrate / 1000).toFixed(0)} kbps`);
  
  // Get base PTS and estimate FPS
  const basePts = parser.videoAccessUnits[0]?.pts || 0;
  const lastPts = parser.videoAccessUnits[parser.videoAccessUnits.length - 1]?.pts || basePts;
  const duration = (lastPts - basePts) / 90000;
  const estFps = parser.videoAccessUnits.length / duration;
  const videoAUs = parser.videoAccessUnits;
  
  log(`Duration: ${duration.toFixed(2)}s, FPS: ${estFps.toFixed(1)}`);
  
  // Setup muxer
  const tsMuxer = new TSMuxer();
  tsMuxer.setHasAudio(hasAudio);
  
  // Pre-add audio samples
  if (hasAudio) {
    const audioSampleRate = parser.audioSampleRate || 44100;
    const audioChannels = parser.audioChannels || 2;
    
    const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const sampleRateIdx = SAMPLE_RATES.indexOf(audioSampleRate);
    const sri = sampleRateIdx >= 0 ? sampleRateIdx : 4;
    
    for (const audioAu of parser.audioAccessUnits) {
      const rawAac = audioAu.data;
      const frameLen = 7 + rawAac.length;
      const adts = new Uint8Array(frameLen);
      
      // ADTS header
      adts[0] = 0xFF;
      adts[1] = 0xF1;
      adts[2] = (1 << 6) | (sri << 2) | ((audioChannels >> 2) & 0x01);
      adts[3] = ((audioChannels & 0x03) << 6) | ((frameLen >> 11) & 0x03);
      adts[4] = (frameLen >> 3) & 0xFF;
      adts[5] = ((frameLen & 0x07) << 5) | 0x1F;
      adts[6] = 0xFC;
      adts.set(rawAac, 7);
      
      // Adjust PTS to start at 0
      const pts90k = audioAu.pts - basePts;
      tsMuxer.addAudioSample(adts, Math.max(0, pts90k));
    }
  }
  
  // Setup encoder
  let gotSpsPps = false;
  let encodedCount = 0;
  
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description && !gotSpsPps) {
        const desc = new Uint8Array(meta.decoderConfig.description);
        const numSps = desc[5] & 0x1f;
        let off = 6;
        const spsLen = (desc[off] << 8) | desc[off + 1];
        const encSps = desc.slice(off + 2, off + 2 + spsLen);
        off += 2 + spsLen;
        const numPps = desc[off++];
        const ppsLen = (desc[off] << 8) | desc[off + 1];
        const encPps = desc.slice(off + 2, off + 2 + ppsLen);
        tsMuxer.setSpsPps(encSps, encPps);
        gotSpsPps = true;
      }
      
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const pts90k = Math.round(chunk.timestamp * 90 / 1000);
      tsMuxer.addVideoSample(data, chunk.type === 'key', pts90k);
      encodedCount++;
    },
    error: e => { throw new Error(`Encoder error: ${e.message}`); }
  });
  
  encoder.configure({
    codec: 'avc1.4d001f',
    width: outW,
    height: outH,
    bitrate,
    framerate: Math.round(estFps),
    latencyMode: 'realtime',
    avc: { format: 'avc' }
  });
  
  // Setup decoder - decoupled from encoder for parallel operation
  const avcC = createAvcC(sps, pps);
  const needsScale = srcW !== outW || srcH !== outH;
  
  // Use OffscreenCanvas for scaling
  const canvas = needsScale ? new OffscreenCanvas(outW, outH) : null;
  const ctx = canvas ? canvas.getContext('2d', { alpha: false }) : null;
  
  let processedCount = 0;
  let decodedCount = 0;
  const frameDuration = Math.round(1_000_000 / estFps);
  const startTime = performance.now();
  
  // Process frames directly - simple pipeline
  const processFrame = (frame, isKey) => {
    let outFrame;
    if (needsScale) {
      ctx.drawImage(frame, 0, 0, outW, outH);
      outFrame = new VideoFrame(canvas, {
        timestamp: frame.timestamp,
        duration: frame.duration || frameDuration
      });
    } else {
      outFrame = new VideoFrame(frame, {
        timestamp: frame.timestamp,
        duration: frame.duration || frameDuration
      });
    }
    encoder.encode(outFrame, { keyFrame: isKey });
    outFrame.close();
    frame.close();
    processedCount++;
    
    if (processedCount % 200 === 0) {
      const elapsed = (performance.now() - encodeStartTime) / 1000;
      log(`Processed ${processedCount}/${videoAUs.length} @ ${(processedCount / elapsed).toFixed(0)} fps`);
    }
  };
  
  // Start encoding processor (runs in parallel with decoding)
  
  const decoder = new VideoDecoder({
    output: (frame) => {
      const isKey = decodedCount % keyFrameInterval === 0;
      processFrame(frame, isKey);
      decodedCount++;
    },
    error: e => { throw new Error(`Decoder error: ${e.message}`); }
  });
  
  decoder.configure({
    codec: codecStr,
    codedWidth: srcW,
    codedHeight: srcH,
    description: avcC
  });
  
  // Decode and encode frames
  log('Transcoding...');
  const encodeStartTime = performance.now();
  
  for (let i = 0; i < videoAUs.length; i++) {
    const au = videoAUs[i];
    
    // Build AVCC-formatted NAL units
    const nalParts = [];
    let isKey = false;
    
    for (const nal of au.nalUnits) {
      const t = nal[0] & 0x1f;
      if (t === 5) isKey = true;
      if (t === 1 || t === 5) {
        const len = nal.length;
        nalParts.push(new Uint8Array([(len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]));
        nalParts.push(nal);
      }
    }
    
    if (nalParts.length > 0) {
      const data = concat(nalParts);
      const pts90k = au.pts !== undefined ? au.pts : basePts + i * (90000 / estFps);
      const timestamp = Math.max(0, Math.round((pts90k - basePts) / 90 * 1000));
      
      decoder.decode(new EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp,
        duration: frameDuration,
        data
      }));
    }
    
    // Yield periodically to let encoder catch up and prevent UI freeze
    if (i % 100 === 0) await new Promise(r => setTimeout(r, 0));
  }
  
  // Flush decoder and encoder
  log('Flushing decoder...');
  await decoder.flush();
  decoder.close();
  
  log(`Flushing encoder (${encoder.encodeQueueSize} frames queued)...`);
  await encoder.flush();
  encoder.close();
  
  // Flush remaining audio
  tsMuxer.flush();
  
  const totalTime = (performance.now() - startTime) / 1000;
  log(`Transcoded ${processedCount} frames in ${totalTime.toFixed(2)}s (${(duration / totalTime).toFixed(1)}x realtime)`);
  
  return tsMuxer.build();
}

// Default export
export default transcode;
