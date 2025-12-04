/**
 * MP4 Muxer
 * 
 * Creates MP4 container from parsed video/audio access units.
 * Takes TSParser output and builds a complete MP4 file.
 * 
 * @example
 * import { MP4Muxer } from 'tomp4';
 * import { TSParser } from 'tomp4';
 * 
 * const parser = new TSParser();
 * parser.parse(tsData);
 * parser.finalize();
 * 
 * const muxer = new MP4Muxer(parser);
 * const mp4Data = muxer.build();
 * 
 * @module muxers/mp4
 */

// ============================================
// MP4 BOX HELPERS
// ============================================

export function createBox(type, ...payloads) {
  let size = 8;
  for (const p of payloads) size += p.byteLength;
  const result = new Uint8Array(size);
  const view = new DataView(result.buffer);
  view.setUint32(0, size);
  result[4] = type.charCodeAt(0);
  result[5] = type.charCodeAt(1);
  result[6] = type.charCodeAt(2);
  result[7] = type.charCodeAt(3);
  let offset = 8;
  for (const p of payloads) {
    result.set(p, offset);
    offset += p.byteLength;
  }
  return result;
}

export function createFullBox(type, version, flags, ...payloads) {
  const header = new Uint8Array(4);
  header[0] = version;
  header[1] = (flags >> 16) & 0xFF;
  header[2] = (flags >> 8) & 0xFF;
  header[3] = flags & 0xFF;
  return createBox(type, header, ...payloads);
}

// ============================================
// H.264 SPS Parser
// ============================================

/**
 * Parse H.264 SPS to extract video dimensions
 * @param {Uint8Array} sps - SPS NAL unit
 * @returns {object} { width, height }
 */
export function parseSPS(sps) {
  const result = { width: 1920, height: 1080 };
  if (!sps || sps.length < 4) return result;
  
  let offset = 1;
  const profile = sps[offset++];
  offset++; // constraint flags
  offset++; // level_idc
  
  let bitPos = offset * 8;
  const getBit = () => (sps[Math.floor(bitPos / 8)] >> (7 - (bitPos++ % 8))) & 1;
  const readUE = () => {
    let zeros = 0;
    while (bitPos < sps.length * 8 && getBit() === 0) zeros++;
    let val = (1 << zeros) - 1;
    for (let i = 0; i < zeros; i++) val += getBit() << (zeros - 1 - i);
    return val;
  };
  const readSE = () => {
    const val = readUE();
    return (val & 1) ? (val + 1) >> 1 : -(val >> 1);
  };
  
  try {
    readUE(); // seq_parameter_set_id
    
    if (profile === 100 || profile === 110 || profile === 122 || profile === 244 ||
        profile === 44 || profile === 83 || profile === 86 || profile === 118 || profile === 128) {
      const chromaFormat = readUE();
      if (chromaFormat === 3) getBit();
      readUE(); readUE();
      getBit();
      if (getBit()) {
        for (let i = 0; i < (chromaFormat !== 3 ? 8 : 12); i++) {
          if (getBit()) {
            const size = i < 6 ? 16 : 64;
            for (let j = 0; j < size; j++) readSE();
          }
        }
      }
    }
    
    readUE(); // log2_max_frame_num_minus4
    const pocType = readUE();
    if (pocType === 0) {
      readUE();
    } else if (pocType === 1) {
      getBit(); readSE(); readSE();
      const numRefFrames = readUE();
      for (let i = 0; i < numRefFrames; i++) readSE();
    }
    
    readUE(); getBit();
    
    const picWidthMbs = readUE() + 1;
    const picHeightMapUnits = readUE() + 1;
    const frameMbsOnly = getBit();
    
    if (!frameMbsOnly) getBit();
    getBit();
    
    let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
    if (getBit()) {
      cropLeft = readUE();
      cropRight = readUE();
      cropTop = readUE();
      cropBottom = readUE();
    }
    
    const mbWidth = 16;
    const mbHeight = frameMbsOnly ? 16 : 32;
    result.width = picWidthMbs * mbWidth - (cropLeft + cropRight) * 2;
    result.height = (2 - frameMbsOnly) * picHeightMapUnits * mbHeight / (frameMbsOnly ? 1 : 2) - (cropTop + cropBottom) * 2;
    
  } catch (e) {
    // Fall back to defaults
  }
  
  return result;
}

// ============================================
// MP4 Muxer
// ============================================

/**
 * MP4 Muxer - creates MP4 container from parsed access units
 */
export class MP4Muxer {
  /**
   * @param {TSParser} parser - Parser with video/audio access units
   */
  constructor(parser) {
    this.parser = parser;
    this.videoTimescale = 90000;
    this.audioTimescale = parser.audioSampleRate || 48000;
    this.audioSampleDuration = 1024;
    this.videoDimensions = null;
  }
  
  getVideoDimensions() {
    if (this.videoDimensions) return this.videoDimensions;
    
    for (const au of this.parser.videoAccessUnits) {
      for (const nalUnit of au.nalUnits) {
        const nalType = nalUnit[0] & 0x1F;
        if (nalType === 7) {
          this.videoDimensions = parseSPS(nalUnit);
          return this.videoDimensions;
        }
      }
    }
    
    this.videoDimensions = { width: 1920, height: 1080 };
    return this.videoDimensions;
  }
  
  /**
   * Build complete MP4 file
   * @returns {Uint8Array}
   */
  build() {
    const mdatContent = this.buildMdatContent();
    const moov = this.buildMoov(mdatContent.byteLength);
    const ftyp = this.buildFtyp();
    const mdatOffset = ftyp.byteLength + moov.byteLength + 8;
    this.updateChunkOffsets(moov, mdatOffset);
    const mdat = createBox('mdat', mdatContent);
    const result = new Uint8Array(ftyp.byteLength + moov.byteLength + mdat.byteLength);
    result.set(ftyp, 0);
    result.set(moov, ftyp.byteLength);
    result.set(mdat, ftyp.byteLength + moov.byteLength);
    return result;
  }
  
  buildFtyp() {
    const data = new Uint8Array(16);
    data[0] = 'i'.charCodeAt(0); data[1] = 's'.charCodeAt(0); data[2] = 'o'.charCodeAt(0); data[3] = 'm'.charCodeAt(0);
    data[7] = 1;
    data[8] = 'i'.charCodeAt(0); data[9] = 's'.charCodeAt(0); data[10] = 'o'.charCodeAt(0); data[11] = 'm'.charCodeAt(0);
    data[12] = 'a'.charCodeAt(0); data[13] = 'v'.charCodeAt(0); data[14] = 'c'.charCodeAt(0); data[15] = '1'.charCodeAt(0);
    return createBox('ftyp', data);
  }
  
  buildMdatContent() {
    const chunks = [];
    this.videoSampleSizes = [];
    this.videoSampleOffsets = [];
    let currentOffset = 0;
    for (const au of this.parser.videoAccessUnits) {
      this.videoSampleOffsets.push(currentOffset);
      let sampleSize = 0;
      for (const nalUnit of au.nalUnits) {
        const prefixed = new Uint8Array(4 + nalUnit.length);
        new DataView(prefixed.buffer).setUint32(0, nalUnit.length);
        prefixed.set(nalUnit, 4);
        chunks.push(prefixed);
        sampleSize += prefixed.length;
      }
      this.videoSampleSizes.push(sampleSize);
      currentOffset += sampleSize;
    }
    this.videoChunkOffset = 0;
    this.audioChunkOffset = currentOffset;
    this.audioSampleSizes = [];
    for (const frame of this.parser.audioAccessUnits) {
      chunks.push(frame.data);
      this.audioSampleSizes.push(frame.data.length);
      currentOffset += frame.data.length;
    }
    const totalSize = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }
  
  buildMoov(mdatSize) {
    const mvhd = this.buildMvhd();
    const videoTrak = this.buildVideoTrak();
    const audioTrak = this.buildAudioTrak();
    const udta = this.buildUdta();
    return createBox('moov', mvhd, videoTrak, audioTrak, udta);
  }
  
  buildUdta() {
    const toolName = 'toMp4.js';
    const toolBytes = new TextEncoder().encode(toolName);
    const dataBox = new Uint8Array(16 + toolBytes.length);
    const dataView = new DataView(dataBox.buffer);
    dataView.setUint32(0, 16 + toolBytes.length);
    dataBox[4] = 'd'.charCodeAt(0); dataBox[5] = 'a'.charCodeAt(0); dataBox[6] = 't'.charCodeAt(0); dataBox[7] = 'a'.charCodeAt(0);
    dataView.setUint32(8, 1); dataView.setUint32(12, 0);
    dataBox.set(toolBytes, 16);
    const tooBox = createBox('©too', dataBox);
    const ilst = createBox('ilst', tooBox);
    const hdlrData = new Uint8Array(21);
    hdlrData[4] = 'm'.charCodeAt(0); hdlrData[5] = 'd'.charCodeAt(0); hdlrData[6] = 'i'.charCodeAt(0); hdlrData[7] = 'r'.charCodeAt(0);
    const metaHdlr = createFullBox('hdlr', 0, 0, hdlrData);
    const meta = createFullBox('meta', 0, 0, new Uint8Array(0), metaHdlr, ilst);
    return createBox('udta', meta);
  }
  
  buildMvhd() {
    const data = new Uint8Array(96);
    const view = new DataView(data.buffer);
    view.setUint32(8, this.videoTimescale);
    view.setUint32(12, this.calculateVideoDuration());
    view.setUint32(16, 0x00010000);
    view.setUint16(20, 0x0100);
    view.setUint32(32, 0x00010000);
    view.setUint32(48, 0x00010000);
    view.setUint32(64, 0x40000000);
    view.setUint32(92, 258);
    return createFullBox('mvhd', 0, 0, data);
  }
  
  calculateVideoDuration() {
    if (this.parser.videoDts.length < 2) return 0;
    const firstDts = this.parser.videoDts[0];
    const lastDts = this.parser.videoDts[this.parser.videoDts.length - 1];
    const avgDuration = (lastDts - firstDts) / (this.parser.videoDts.length - 1);
    return Math.round(lastDts - firstDts + avgDuration);
  }
  
  buildVideoTrak() {
    const edts = this.buildVideoEdts();
    if (edts) {
      return createBox('trak', this.buildVideoTkhd(), edts, this.buildVideoMdia());
    }
    return createBox('trak', this.buildVideoTkhd(), this.buildVideoMdia());
  }
  
  buildVideoEdts() {
    if (this.parser.videoAccessUnits.length === 0) return null;
    
    const firstAU = this.parser.videoAccessUnits[0];
    const firstVideoPts = firstAU.pts;
    
    if (firstVideoPts === 0) return null;
    
    const duration = this.calculateVideoDuration();
    const mediaTime = firstVideoPts;
    
    const elstData = new Uint8Array(16);
    const view = new DataView(elstData.buffer);
    view.setUint32(0, 1);
    view.setUint32(4, duration);
    view.setInt32(8, mediaTime);
    view.setUint16(12, 1);
    view.setUint16(14, 0);
    
    const elst = createFullBox('elst', 0, 0, elstData);
    return createBox('edts', elst);
  }
  
  buildVideoTkhd() {
    const { width, height } = this.getVideoDimensions();
    const data = new Uint8Array(80);
    const view = new DataView(data.buffer);
    view.setUint32(8, 256);
    view.setUint32(16, this.calculateVideoDuration());
    view.setUint16(32, 0);
    view.setUint32(36, 0x00010000);
    view.setUint32(52, 0x00010000);
    view.setUint32(68, 0x40000000);
    view.setUint32(72, width << 16);
    view.setUint32(76, height << 16);
    return createFullBox('tkhd', 0, 3, data);
  }
  
  buildVideoMdia() {
    return createBox('mdia', this.buildVideoMdhd(), this.buildVideoHdlr(), this.buildVideoMinf());
  }
  
  buildVideoMdhd() {
    const data = new Uint8Array(20);
    const view = new DataView(data.buffer);
    view.setUint32(8, this.videoTimescale);
    view.setUint32(12, this.calculateVideoDuration());
    view.setUint16(16, 0x55C4);
    return createFullBox('mdhd', 0, 0, data);
  }
  
  buildVideoHdlr() {
    const data = new Uint8Array(21);
    data[4] = 'v'.charCodeAt(0); data[5] = 'i'.charCodeAt(0); data[6] = 'd'.charCodeAt(0); data[7] = 'e'.charCodeAt(0);
    return createFullBox('hdlr', 0, 0, data);
  }
  
  buildVideoMinf() {
    return createBox('minf', this.buildVmhd(), this.buildDinf(), this.buildVideoStbl());
  }
  
  buildVmhd() { return createFullBox('vmhd', 0, 1, new Uint8Array(8)); }
  
  buildDinf() {
    const urlBox = createFullBox('url ', 0, 1, new Uint8Array(0));
    const dref = createFullBox('dref', 0, 0, new Uint8Array([0, 0, 0, 1]), urlBox);
    return createBox('dinf', dref);
  }
  
  buildVideoStbl() {
    const boxes = [this.buildVideoStsd(), this.buildVideoStts(), this.buildVideoCtts(), this.buildVideoStsc(), this.buildVideoStsz(), this.buildVideoStco()];
    const stss = this.buildVideoStss();
    if (stss) boxes.push(stss);
    return createBox('stbl', ...boxes);
  }
  
  buildVideoStsd() {
    const { width, height } = this.getVideoDimensions();
    const avcC = this.buildAvcC();
    const btrtData = new Uint8Array(12);
    const btrtView = new DataView(btrtData.buffer);
    btrtView.setUint32(4, 2000000); btrtView.setUint32(8, 2000000);
    const btrt = createBox('btrt', btrtData);
    const paspData = new Uint8Array(8);
    const paspView = new DataView(paspData.buffer);
    paspView.setUint32(0, 1); paspView.setUint32(4, 1);
    const pasp = createBox('pasp', paspData);
    const avc1Data = new Uint8Array(78 + avcC.byteLength + btrt.byteLength + pasp.byteLength);
    const view = new DataView(avc1Data.buffer);
    view.setUint16(6, 1); view.setUint16(24, width); view.setUint16(26, height);
    view.setUint32(28, 0x00480000); view.setUint32(32, 0x00480000);
    view.setUint16(40, 1); view.setUint16(74, 0x0018); view.setInt16(76, -1);
    avc1Data.set(avcC, 78); avc1Data.set(btrt, 78 + avcC.byteLength); avc1Data.set(pasp, 78 + avcC.byteLength + btrt.byteLength);
    const avc1 = createBox('avc1', avc1Data);
    const stsdHeader = new Uint8Array(4);
    new DataView(stsdHeader.buffer).setUint32(0, 1);
    return createFullBox('stsd', 0, 0, stsdHeader, avc1);
  }
  
  buildAvcC() {
    let sps = null, pps = null;
    for (const au of this.parser.videoAccessUnits) {
      for (const nalUnit of au.nalUnits) {
        const nalType = nalUnit[0] & 0x1F;
        if (nalType === 7 && !sps) sps = nalUnit;
        if (nalType === 8 && !pps) pps = nalUnit;
        if (sps && pps) break;
      }
      if (sps && pps) break;
    }
    if (!sps || !pps) {
      sps = new Uint8Array([0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xf0, 0x3c, 0x60, 0xc6, 0x58]);
      pps = new Uint8Array([0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0]);
    }
    const data = new Uint8Array(11 + sps.length + pps.length);
    const view = new DataView(data.buffer);
    data[0] = 1; data[1] = sps[1]; data[2] = sps[2]; data[3] = sps[3]; data[4] = 0xFF; data[5] = 0xE1;
    view.setUint16(6, sps.length); data.set(sps, 8);
    data[8 + sps.length] = 1; view.setUint16(9 + sps.length, pps.length); data.set(pps, 11 + sps.length);
    return createBox('avcC', data);
  }
  
  buildVideoStts() {
    const entries = [];
    let lastDuration = -1, count = 0;
    for (let i = 0; i < this.parser.videoDts.length; i++) {
      const duration = i < this.parser.videoDts.length - 1 
        ? this.parser.videoDts[i + 1] - this.parser.videoDts[i] 
        : (entries.length > 0 ? entries[entries.length - 1].duration : 3003);
      if (duration === lastDuration) count++;
      else { if (count > 0) entries.push({ count, duration: lastDuration }); lastDuration = duration; count = 1; }
    }
    if (count > 0) entries.push({ count, duration: lastDuration });
    const data = new Uint8Array(4 + entries.length * 8);
    const view = new DataView(data.buffer);
    view.setUint32(0, entries.length);
    for (let i = 0; i < entries.length; i++) { view.setUint32(4 + i * 8, entries[i].count); view.setUint32(8 + i * 8, entries[i].duration); }
    return createFullBox('stts', 0, 0, data);
  }
  
  buildVideoCtts() {
    const entries = [];
    for (const au of this.parser.videoAccessUnits) {
      const cts = au.pts - au.dts;
      if (entries.length > 0 && entries[entries.length - 1].offset === cts) entries[entries.length - 1].count++;
      else entries.push({ count: 1, offset: cts });
    }
    const data = new Uint8Array(4 + entries.length * 8);
    const view = new DataView(data.buffer);
    view.setUint32(0, entries.length);
    for (let i = 0; i < entries.length; i++) { view.setUint32(4 + i * 8, entries[i].count); view.setUint32(8 + i * 8, entries[i].offset); }
    return createFullBox('ctts', 0, 0, data);
  }
  
  buildVideoStsc() {
    const data = new Uint8Array(4 + 12);
    const view = new DataView(data.buffer);
    view.setUint32(0, 1); view.setUint32(4, 1); view.setUint32(8, this.videoSampleSizes.length); view.setUint32(12, 1);
    return createFullBox('stsc', 0, 0, data);
  }
  
  buildVideoStsz() {
    const data = new Uint8Array(8 + this.videoSampleSizes.length * 4);
    const view = new DataView(data.buffer);
    view.setUint32(0, 0); view.setUint32(4, this.videoSampleSizes.length);
    for (let i = 0; i < this.videoSampleSizes.length; i++) view.setUint32(8 + i * 4, this.videoSampleSizes[i]);
    return createFullBox('stsz', 0, 0, data);
  }
  
  buildVideoStco() {
    const data = new Uint8Array(8);
    const view = new DataView(data.buffer);
    view.setUint32(0, 1); view.setUint32(4, 0);
    return createFullBox('stco', 0, 0, data);
  }
  
  buildVideoStss() {
    const keyframes = [];
    for (let i = 0; i < this.parser.videoAccessUnits.length; i++) {
      for (const nalUnit of this.parser.videoAccessUnits[i].nalUnits) {
        if ((nalUnit[0] & 0x1F) === 5) { keyframes.push(i + 1); break; }
      }
    }
    if (keyframes.length === 0) return null;
    const data = new Uint8Array(4 + keyframes.length * 4);
    const view = new DataView(data.buffer);
    view.setUint32(0, keyframes.length);
    for (let i = 0; i < keyframes.length; i++) view.setUint32(4 + i * 4, keyframes[i]);
    return createFullBox('stss', 0, 0, data);
  }
  
  buildAudioTrak() {
    const edts = this.buildAudioEdts();
    if (edts) {
      return createBox('trak', this.buildAudioTkhd(), edts, this.buildAudioMdia());
    }
    return createBox('trak', this.buildAudioTkhd(), this.buildAudioMdia());
  }
  
  buildAudioEdts() {
    if (this.parser.audioPts.length === 0) return null;
    
    const firstAudioPts = this.parser.audioPts[0];
    if (firstAudioPts === 0) return null;
    
    const mediaTime = Math.round(firstAudioPts * this.audioTimescale / 90000);
    const duration = this.audioSampleSizes.length * this.audioSampleDuration;
    
    const elstData = new Uint8Array(16);
    const view = new DataView(elstData.buffer);
    view.setUint32(0, 1);
    view.setUint32(4, Math.round(duration * this.videoTimescale / this.audioTimescale));
    view.setInt32(8, mediaTime);
    view.setUint16(12, 1);
    view.setUint16(14, 0);
    
    const elst = createFullBox('elst', 0, 0, elstData);
    return createBox('edts', elst);
  }
  
  buildAudioTkhd() {
    const data = new Uint8Array(80);
    const view = new DataView(data.buffer);
    view.setUint32(8, 257);
    const audioDuration = this.audioSampleSizes.length * this.audioSampleDuration;
    view.setUint32(16, Math.round(audioDuration * this.videoTimescale / this.audioTimescale));
    view.setUint16(32, 0x0100);
    view.setUint32(36, 0x00010000); view.setUint32(52, 0x00010000); view.setUint32(68, 0x40000000);
    return createFullBox('tkhd', 0, 3, data);
  }
  
  buildAudioMdia() { return createBox('mdia', this.buildAudioMdhd(), this.buildAudioHdlr(), this.buildAudioMinf()); }
  
  buildAudioMdhd() {
    const data = new Uint8Array(20);
    const view = new DataView(data.buffer);
    view.setUint32(8, this.audioTimescale);
    view.setUint32(12, this.audioSampleSizes.length * this.audioSampleDuration);
    view.setUint16(16, 0x55C4);
    return createFullBox('mdhd', 0, 0, data);
  }
  
  buildAudioHdlr() {
    const data = new Uint8Array(21);
    data[4] = 's'.charCodeAt(0); data[5] = 'o'.charCodeAt(0); data[6] = 'u'.charCodeAt(0); data[7] = 'n'.charCodeAt(0);
    return createFullBox('hdlr', 0, 0, data);
  }
  
  buildAudioMinf() { return createBox('minf', this.buildSmhd(), this.buildDinf(), this.buildAudioStbl()); }
  buildSmhd() { return createFullBox('smhd', 0, 0, new Uint8Array(4)); }
  
  buildAudioStbl() {
    return createBox('stbl', this.buildAudioStsd(), this.buildAudioStts(), this.buildAudioStsc(), this.buildAudioStsz(), this.buildAudioStco());
  }
  
  buildAudioStsd() {
    const esds = this.buildEsds();
    const channels = this.parser.audioChannels || 2;
    const mp4aData = new Uint8Array(28 + esds.byteLength);
    const view = new DataView(mp4aData.buffer);
    view.setUint16(6, 1); 
    view.setUint16(16, channels);
    view.setUint16(18, 16);
    view.setUint32(24, this.audioTimescale << 16);
    mp4aData.set(esds, 28);
    const mp4a = createBox('mp4a', mp4aData);
    const stsdHeader = new Uint8Array(4);
    new DataView(stsdHeader.buffer).setUint32(0, 1);
    return createFullBox('stsd', 0, 0, stsdHeader, mp4a);
  }
  
  buildEsds() {
    const SAMPLE_RATE_INDEX = {
      96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5,
      24000: 6, 22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11, 7350: 12
    };
    
    const sampleRate = this.audioTimescale;
    const channels = this.parser.audioChannels || 2;
    const samplingFreqIndex = SAMPLE_RATE_INDEX[sampleRate] ?? 4;
    
    const audioConfig = ((2 << 11) | (samplingFreqIndex << 7) | (channels << 3)) & 0xFFFF;
    const audioConfigHigh = (audioConfig >> 8) & 0xFF;
    const audioConfigLow = audioConfig & 0xFF;
    
    const data = new Uint8Array([
      0x00, 0x00, 0x00, 0x00,
      0x03, 0x19,
      0x00, 0x02,
      0x00,
      0x04, 0x11,
      0x40,
      0x15,
      0x00, 0x00, 0x00,
      0x00, 0x01, 0xF4, 0x00,
      0x00, 0x01, 0xF4, 0x00,
      0x05, 0x02,
      audioConfigHigh, audioConfigLow,
      0x06, 0x01, 0x02
    ]);
    return createBox('esds', data);
  }
  
  buildAudioStts() {
    const audioPts = this.parser.audioPts;
    
    if (audioPts.length < 2) {
      const data = new Uint8Array(12);
      const view = new DataView(data.buffer);
      view.setUint32(0, 1); 
      view.setUint32(4, this.audioSampleSizes.length); 
      view.setUint32(8, this.audioSampleDuration);
      return createFullBox('stts', 0, 0, data);
    }
    
    const entries = [];
    let lastDuration = -1, count = 0;
    
    for (let i = 0; i < audioPts.length; i++) {
      let duration;
      if (i < audioPts.length - 1) {
        const ptsDiff = audioPts[i + 1] - audioPts[i];
        duration = Math.round(ptsDiff * this.audioTimescale / 90000);
      } else {
        duration = this.audioSampleDuration;
      }
      
      if (duration <= 0 || duration > this.audioSampleDuration * 2) {
        duration = this.audioSampleDuration;
      }
      
      if (duration === lastDuration) {
        count++;
      } else {
        if (count > 0) entries.push({ count, duration: lastDuration });
        lastDuration = duration;
        count = 1;
      }
    }
    if (count > 0) entries.push({ count, duration: lastDuration });
    
    const data = new Uint8Array(4 + entries.length * 8);
    const view = new DataView(data.buffer);
    view.setUint32(0, entries.length);
    for (let i = 0; i < entries.length; i++) {
      view.setUint32(4 + i * 8, entries[i].count);
      view.setUint32(8 + i * 8, entries[i].duration);
    }
    return createFullBox('stts', 0, 0, data);
  }
  
  buildAudioStsc() {
    const data = new Uint8Array(4 + 12);
    const view = new DataView(data.buffer);
    view.setUint32(0, 1); view.setUint32(4, 1); view.setUint32(8, this.audioSampleSizes.length); view.setUint32(12, 1);
    return createFullBox('stsc', 0, 0, data);
  }
  
  buildAudioStsz() {
    const data = new Uint8Array(8 + this.audioSampleSizes.length * 4);
    const view = new DataView(data.buffer);
    view.setUint32(0, 0); view.setUint32(4, this.audioSampleSizes.length);
    for (let i = 0; i < this.audioSampleSizes.length; i++) view.setUint32(8 + i * 4, this.audioSampleSizes[i]);
    return createFullBox('stsz', 0, 0, data);
  }
  
  buildAudioStco() {
    const data = new Uint8Array(8);
    const view = new DataView(data.buffer);
    view.setUint32(0, 1); view.setUint32(4, 0);
    return createFullBox('stco', 0, 0, data);
  }
  
  updateChunkOffsets(moov, mdatOffset) { this.updateStcoInBox(moov, mdatOffset, 0); }
  
  updateStcoInBox(data, mdatOffset, trackIndex) {
    let offset = 8;
    while (offset < data.byteLength - 8) {
      const view = new DataView(data.buffer, data.byteOffset + offset);
      const size = view.getUint32(0);
      const type = String.fromCharCode(data[offset+4], data[offset+5], data[offset+6], data[offset+7]);
      if (size < 8 || offset + size > data.byteLength) break;
      if (type === 'stco') {
        view.setUint32(16, trackIndex === 0 ? mdatOffset + this.videoChunkOffset : mdatOffset + this.audioChunkOffset);
        trackIndex++;
      } else if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) {
        trackIndex = this.updateStcoInBox(data.subarray(offset, offset + size), mdatOffset, trackIndex);
      }
      offset += size;
    }
    return trackIndex;
  }
}

// Alias for backwards compatibility
export { MP4Muxer as MP4Builder };

export default MP4Muxer;

