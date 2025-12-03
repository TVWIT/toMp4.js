/**
 * toMp4.js v1.0.4
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
  
  // Stream type info
  const STREAM_TYPES = {
    0x01: { name: 'MPEG-1 Video', supported: false },
    0x02: { name: 'MPEG-2 Video', supported: false },
    0x03: { name: 'MPEG-1 Audio (MP3)', supported: false },
    0x04: { name: 'MPEG-2 Audio', supported: false },
    0x0F: { name: 'AAC', supported: true },
    0x11: { name: 'AAC-LATM', supported: true },
    0x1B: { name: 'H.264/AVC', supported: true },
    0x24: { name: 'H.265/HEVC', supported: true },
    0x81: { name: 'AC-3 (Dolby)', supported: false },
    0x87: { name: 'E-AC-3', supported: false }
  };
  
  // ============================================
  // MP4 BOX HELPERS
  // ============================================
  function createBox(type, ...payloads) {
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
  
  function createFullBox(type, version, flags, ...payloads) {
    const header = new Uint8Array(4);
    header[0] = version;
    header[1] = (flags >> 16) & 0xFF;
    header[2] = (flags >> 8) & 0xFF;
    header[3] = flags & 0xFF;
    return createBox(type, header, ...payloads);
  }
  
  // ============================================
  // MPEG-TS PARSER
  // ============================================
  const TS_PACKET_SIZE = 188;
  const TS_SYNC_BYTE = 0x47;
  const PAT_PID = 0x0000;
  
  class TSParser {
    constructor() {
      this.pmtPid = null;
      this.videoPid = null;
      this.audioPid = null;
      this.videoStreamType = null;
      this.audioStreamType = null;
      this.videoPesBuffer = [];
      this.audioPesBuffer = [];
      this.videoAccessUnits = [];
      this.audioAccessUnits = [];
      this.videoPts = [];
      this.videoDts = [];
      this.audioPts = [];
      this.lastAudioPts = null; // Track running audio timestamp
      this.adtsPartial = null; // Partial ADTS frame from previous PES
      this.audioSampleRate = null; // Detected from ADTS header
      this.audioChannels = null;
      this.debug = { packets: 0, patFound: false, pmtFound: false };
    }
    
    parse(data) {
      let offset = 0;
      // Find first sync byte
      while (offset < data.byteLength && data[offset] !== TS_SYNC_BYTE) offset++;
      if (offset > 0) this.debug.skippedBytes = offset;
      
      // Parse all packets
      while (offset + TS_PACKET_SIZE <= data.byteLength) {
        if (data[offset] !== TS_SYNC_BYTE) {
          // Try to resync
          const nextSync = data.indexOf(TS_SYNC_BYTE, offset + 1);
          if (nextSync === -1) break;
          offset = nextSync;
          continue;
        }
        this.parsePacket(data.subarray(offset, offset + TS_PACKET_SIZE));
        this.debug.packets++;
        offset += TS_PACKET_SIZE;
      }
    }
    
    parsePacket(packet) {
      const pid = ((packet[1] & 0x1F) << 8) | packet[2];
      const payloadStart = (packet[1] & 0x40) !== 0;
      const adaptationField = (packet[3] & 0x30) >> 4;
      let payloadOffset = 4;
      if (adaptationField === 2 || adaptationField === 3) {
        const adaptLen = packet[4];
        payloadOffset = 5 + adaptLen;
        if (payloadOffset >= TS_PACKET_SIZE) return; // Invalid adaptation field
      }
      if (adaptationField === 2) return; // No payload
      if (payloadOffset >= packet.length) return;
      
      const payload = packet.subarray(payloadOffset);
      if (payload.length === 0) return;
      
      if (pid === PAT_PID) this.parsePAT(payload);
      else if (pid === this.pmtPid) this.parsePMT(payload);
      else if (pid === this.videoPid) this.collectPES(payload, payloadStart, 'video');
      else if (pid === this.audioPid) this.collectPES(payload, payloadStart, 'audio');
    }
    
    parsePAT(payload) {
      if (payload.length < 12) return;
      let offset = payload[0] + 1; // pointer field
      if (offset + 8 > payload.length) return;
      
      // table_id + section_syntax + section_length + transport_stream_id + version + section_number + last_section_number
      offset += 8;
      
      while (offset + 4 <= payload.length - 4) { // -4 for CRC
        const programNum = (payload[offset] << 8) | payload[offset + 1];
        const pmtPid = ((payload[offset + 2] & 0x1F) << 8) | payload[offset + 3];
        if (programNum !== 0 && pmtPid !== 0) {
          this.pmtPid = pmtPid;
          this.debug.patFound = true;
          break;
        }
        offset += 4;
      }
    }
    
    parsePMT(payload) {
      if (payload.length < 16) return;
      let offset = payload[0] + 1; // pointer field
      if (offset + 12 > payload.length) return;
      
      // table_id
      offset++;
      
      const sectionLength = ((payload[offset] & 0x0F) << 8) | payload[offset + 1];
      offset += 2;
      
      // program_number(2) + version(1) + section_number(1) + last_section(1)
      offset += 5;
      
      // PCR_PID (2)
      offset += 2;
      
      // program_info_length
      if (offset + 2 > payload.length) return;
      const programInfoLength = ((payload[offset] & 0x0F) << 8) | payload[offset + 1];
      offset += 2 + programInfoLength;
      
      // Calculate end of stream entries (before CRC)
      const sectionEnd = Math.min(payload.length - 4, 1 + payload[0] + 3 + sectionLength - 4);
      
      while (offset + 5 <= sectionEnd) {
        const streamType = payload[offset];
        const elementaryPid = ((payload[offset + 1] & 0x1F) << 8) | payload[offset + 2];
        const esInfoLength = ((payload[offset + 3] & 0x0F) << 8) | payload[offset + 4];
        
        // Track ANY video stream we find (we'll validate codec support later)
        // Video types: 0x01=MPEG-1, 0x02=MPEG-2, 0x1B=H.264, 0x24=HEVC
        if (!this.videoPid && (streamType === 0x01 || streamType === 0x02 || streamType === 0x1B || streamType === 0x24)) {
          this.videoPid = elementaryPid;
          this.videoStreamType = streamType;
          this.debug.pmtFound = true;
        }
        // Track ANY audio stream we find (we'll validate codec support later)
        // Audio types: 0x03=MPEG-1, 0x04=MPEG-2, 0x0F=AAC, 0x11=AAC-LATM, 0x81=AC3, 0x87=EAC3
        else if (!this.audioPid && (streamType === 0x03 || streamType === 0x04 || streamType === 0x0F || streamType === 0x11 || streamType === 0x81 || streamType === 0x87)) {
          this.audioPid = elementaryPid;
          this.audioStreamType = streamType;
        }
        
        offset += 5 + esInfoLength;
      }
    }
    
    collectPES(payload, isStart, type) {
      const buffer = type === 'video' ? this.videoPesBuffer : this.audioPesBuffer;
      if (isStart) {
        if (type === 'audio') this.debug.audioPesStarts = (this.debug.audioPesStarts || 0) + 1;
        if (buffer.length > 0) this.processPES(this.concatenateBuffers(buffer), type);
        buffer.length = 0;
      }
      buffer.push(payload.slice());
    }
    
    processPES(pesData, type) {
      if (pesData.length < 9) return;
      if (pesData[0] !== 0 || pesData[1] !== 0 || pesData[2] !== 1) return;
      const flags = pesData[7];
      const headerDataLength = pesData[8];
      let pts = null, dts = null;
      if (flags & 0x80) pts = this.parsePTS(pesData, 9);
      if (flags & 0x40) dts = this.parsePTS(pesData, 14);
      const payload = pesData.subarray(9 + headerDataLength);
      if (type === 'video') this.processVideoPayload(payload, pts, dts);
      else this.processAudioPayload(payload, pts);
    }
    
    parsePTS(data, offset) {
      return ((data[offset] & 0x0E) << 29) |
        ((data[offset + 1]) << 22) |
        ((data[offset + 2] & 0xFE) << 14) |
        ((data[offset + 3]) << 7) |
        ((data[offset + 4] & 0xFE) >> 1);
    }
    
    processVideoPayload(payload, pts, dts) {
      const nalUnits = this.extractNALUnits(payload);
      if (nalUnits.length > 0 && pts !== null) {
        this.videoAccessUnits.push({ nalUnits, pts, dts: dts !== null ? dts : pts });
        this.videoPts.push(pts);
        this.videoDts.push(dts !== null ? dts : pts);
      }
    }
    
    extractNALUnits(data) {
      const nalUnits = [];
      let i = 0;
      while (i < data.length - 3) {
        if (data[i] === 0 && data[i + 1] === 0) {
          let startCodeLen = 0;
          if (data[i + 2] === 1) startCodeLen = 3;
          else if (data[i + 2] === 0 && i + 3 < data.length && data[i + 3] === 1) startCodeLen = 4;
          if (startCodeLen > 0) {
            let end = i + startCodeLen;
            while (end < data.length - 2) {
              if (data[end] === 0 && data[end + 1] === 0 && 
                  (data[end + 2] === 1 || (data[end + 2] === 0 && end + 3 < data.length && data[end + 3] === 1))) break;
              end++;
            }
            if (end >= data.length - 2) end = data.length;
            const nalUnit = data.subarray(i + startCodeLen, end);
            if (nalUnit.length > 0) nalUnits.push(nalUnit);
            i = end;
            continue;
          }
        }
        i++;
      }
      return nalUnits;
    }
    
    processAudioPayload(payload, pts) {
      const frames = this.extractADTSFrames(payload);
      
      // Debug: track audio PES processing
      this.debug.audioPesCount = (this.debug.audioPesCount || 0) + 1;
      this.debug.audioFramesInPes = (this.debug.audioFramesInPes || 0) + frames.length;
      
      // Use provided PTS or continue from last known PTS
      if (pts !== null) {
        this.lastAudioPts = pts;
      } else if (this.lastAudioPts !== null) {
        pts = this.lastAudioPts;
      } else {
        // No PTS available yet, skip these frames
        this.debug.audioSkipped = (this.debug.audioSkipped || 0) + frames.length;
        return;
      }
      
      // Calculate PTS increment based on detected sample rate (or default 48000)
      const sampleRate = this.audioSampleRate || 48000;
      const ptsIncrement = Math.round(1024 * 90000 / sampleRate);
      
      for (const frame of frames) {
        this.audioAccessUnits.push({ data: frame.data, pts });
        this.audioPts.push(pts);
        pts += ptsIncrement;
        this.lastAudioPts = pts;
      }
    }
    
    extractADTSFrames(data) {
      // ADTS sample rate table
      const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
      
      const frames = [];
      let i = 0;
      
      // Check for leftover partial frame from previous PES
      if (this.adtsPartial && this.adtsPartial.length > 0) {
        const combined = new Uint8Array(this.adtsPartial.length + data.length);
        combined.set(this.adtsPartial);
        combined.set(data, this.adtsPartial.length);
        data = combined;
        this.adtsPartial = null;
      }
      
      while (i < data.length - 7) {
        if (data[i] === 0xFF && (data[i + 1] & 0xF0) === 0xF0) {
          const protectionAbsent = data[i + 1] & 0x01;
          const frameLength = ((data[i + 3] & 0x03) << 11) | (data[i + 4] << 3) | ((data[i + 5] & 0xE0) >> 5);
          
          // Extract sample rate and channel config from first valid frame
          if (!this.audioSampleRate && frameLength > 0) {
            const samplingFreqIndex = ((data[i + 2] & 0x3C) >> 2);
            const channelConfig = ((data[i + 2] & 0x01) << 2) | ((data[i + 3] & 0xC0) >> 6);
            if (samplingFreqIndex < SAMPLE_RATES.length) {
              this.audioSampleRate = SAMPLE_RATES[samplingFreqIndex];
              this.audioChannels = channelConfig;
            }
          }
          
          if (frameLength > 0) {
            if (i + frameLength <= data.length) {
              const headerSize = protectionAbsent ? 7 : 9;
              frames.push({ header: data.subarray(i, i + headerSize), data: data.subarray(i + headerSize, i + frameLength) });
              i += frameLength;
              continue;
            } else {
              this.adtsPartial = data.slice(i);
              break;
            }
          }
        }
        i++;
      }
      return frames;
    }
    
    concatenateBuffers(buffers) {
      const totalLength = buffers.reduce((sum, b) => sum + b.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const buf of buffers) { result.set(buf, offset); offset += buf.length; }
      return result;
    }
    
    finalize() {
      if (this.videoPesBuffer.length > 0) this.processPES(this.concatenateBuffers(this.videoPesBuffer), 'video');
      if (this.audioPesBuffer.length > 0) this.processPES(this.concatenateBuffers(this.audioPesBuffer), 'audio');
      
      // Normalize timestamps so both audio and video start at 0
      // This fixes A/V sync issues when streams have different start times
      this.normalizeTimestamps();
    }
    
    normalizeTimestamps() {
      // Find the minimum timestamp across all streams
      let minPts = Infinity;
      
      if (this.videoPts.length > 0) {
        minPts = Math.min(minPts, Math.min(...this.videoPts));
      }
      if (this.audioPts.length > 0) {
        minPts = Math.min(minPts, Math.min(...this.audioPts));
      }
      
      // If no valid timestamps, nothing to normalize
      if (minPts === Infinity || minPts === 0) return;
      
      // Subtract minimum from all timestamps
      for (let i = 0; i < this.videoPts.length; i++) {
        this.videoPts[i] -= minPts;
      }
      for (let i = 0; i < this.videoDts.length; i++) {
        this.videoDts[i] -= minPts;
      }
      for (let i = 0; i < this.audioPts.length; i++) {
        this.audioPts[i] -= minPts;
      }
      
      // Also update the access units
      for (const au of this.videoAccessUnits) {
        au.pts -= minPts;
        au.dts -= minPts;
      }
      for (const au of this.audioAccessUnits) {
        au.pts -= minPts;
      }
      
      this.debug.timestampOffset = minPts;
      this.debug.timestampNormalized = true;
    }
  }
  
  // ============================================
  // MP4 BUILDER
  // ============================================
  // Parse H.264 SPS to extract video dimensions
  function parseSPS(sps) {
    // Default fallback
    const result = { width: 1920, height: 1080 };
    if (!sps || sps.length < 4) return result;
    
    // Skip NAL header byte, start at profile_idc
    let offset = 1;
    const profile = sps[offset++];
    offset++; // constraint flags
    offset++; // level_idc
    
    // Exponential-Golomb decoder
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
      
      // High profile needs chroma_format_idc parsing
      if (profile === 100 || profile === 110 || profile === 122 || profile === 244 ||
          profile === 44 || profile === 83 || profile === 86 || profile === 118 || profile === 128) {
        const chromaFormat = readUE();
        if (chromaFormat === 3) getBit(); // separate_colour_plane_flag
        readUE(); // bit_depth_luma_minus8
        readUE(); // bit_depth_chroma_minus8
        getBit(); // qpprime_y_zero_transform_bypass_flag
        if (getBit()) { // seq_scaling_matrix_present_flag
          for (let i = 0; i < (chromaFormat !== 3 ? 8 : 12); i++) {
            if (getBit()) { // scaling_list_present
              const size = i < 6 ? 16 : 64;
              for (let j = 0; j < size; j++) readSE();
            }
          }
        }
      }
      
      readUE(); // log2_max_frame_num_minus4
      const pocType = readUE();
      if (pocType === 0) {
        readUE(); // log2_max_pic_order_cnt_lsb_minus4
      } else if (pocType === 1) {
        getBit(); // delta_pic_order_always_zero_flag
        readSE(); // offset_for_non_ref_pic
        readSE(); // offset_for_top_to_bottom_field
        const numRefFrames = readUE();
        for (let i = 0; i < numRefFrames; i++) readSE();
      }
      
      readUE(); // max_num_ref_frames
      getBit(); // gaps_in_frame_num_value_allowed_flag
      
      const picWidthMbs = readUE() + 1;
      const picHeightMapUnits = readUE() + 1;
      const frameMbsOnly = getBit();
      
      if (!frameMbsOnly) getBit(); // mb_adaptive_frame_field_flag
      getBit(); // direct_8x8_inference_flag
      
      let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
      if (getBit()) { // frame_cropping_flag
        cropLeft = readUE();
        cropRight = readUE();
        cropTop = readUE();
        cropBottom = readUE();
      }
      
      // Calculate dimensions
      const mbWidth = 16;
      const mbHeight = frameMbsOnly ? 16 : 32;
      result.width = picWidthMbs * mbWidth - (cropLeft + cropRight) * 2;
      result.height = (2 - frameMbsOnly) * picHeightMapUnits * mbHeight / (frameMbsOnly ? 1 : 2) - (cropTop + cropBottom) * 2;
      
    } catch (e) {
      // Fall back to defaults on parse error
    }
    
    return result;
  }
  
  class MP4Builder {
    constructor(parser) {
      this.parser = parser;
      this.videoTimescale = 90000;
      // Use detected sample rate or default to 48000
      this.audioTimescale = parser.audioSampleRate || 48000;
      this.audioSampleDuration = 1024;
      this.videoDimensions = null;
    }
    
    getVideoDimensions() {
      if (this.videoDimensions) return this.videoDimensions;
      
      // Find SPS NAL unit
      for (const au of this.parser.videoAccessUnits) {
        for (const nalUnit of au.nalUnits) {
          const nalType = nalUnit[0] & 0x1F;
          if (nalType === 7) {
            this.videoDimensions = parseSPS(nalUnit);
            return this.videoDimensions;
          }
        }
      }
      
      // Fallback
      this.videoDimensions = { width: 1920, height: 1080 };
      return this.videoDimensions;
    }
    
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
    
    // Build edit list to fix A/V sync
    // The elst box tells the player where media actually starts
    buildVideoEdts() {
      // Get first video PTS (presentation time)
      if (this.parser.videoAccessUnits.length === 0) return null;
      
      const firstAU = this.parser.videoAccessUnits[0];
      const firstVideoPts = firstAU.pts;
      
      // If video starts at 0, no edit needed
      if (firstVideoPts === 0) return null;
      
      // Create elst box: tells player to start at firstVideoPts in the media
      // This compensates for CTTS offset making video appear to start late
      const duration = this.calculateVideoDuration();
      const mediaTime = firstVideoPts; // Start playback at this media time
      
      // elst entry: segment_duration (4), media_time (4), media_rate (4)
      const elstData = new Uint8Array(16);
      const view = new DataView(elstData.buffer);
      view.setUint32(0, 1); // entry count
      view.setUint32(4, duration); // segment duration in movie timescale
      view.setInt32(8, mediaTime); // media time - where to start
      view.setUint16(12, 1); // media rate integer (1.0)
      view.setUint16(14, 0); // media rate fraction
      
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
    
    // Build edit list for audio to sync with video
    buildAudioEdts() {
      if (this.parser.audioPts.length === 0) return null;
      
      const firstAudioPts = this.parser.audioPts[0];
      
      // If audio starts at 0, no edit needed
      if (firstAudioPts === 0) return null;
      
      // Convert audio PTS (90kHz) to audio timescale (48kHz)
      const mediaTime = Math.round(firstAudioPts * this.audioTimescale / 90000);
      const duration = this.audioSampleSizes.length * this.audioSampleDuration;
      
      const elstData = new Uint8Array(16);
      const view = new DataView(elstData.buffer);
      view.setUint32(0, 1); // entry count
      view.setUint32(4, Math.round(duration * this.videoTimescale / this.audioTimescale)); // segment duration in movie timescale
      view.setInt32(8, mediaTime); // media time
      view.setUint16(12, 1); // media rate integer
      view.setUint16(14, 0); // media rate fraction
      
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
      view.setUint16(16, channels); // channel count
      view.setUint16(18, 16); // sample size
      view.setUint32(24, this.audioTimescale << 16);
      mp4aData.set(esds, 28);
      const mp4a = createBox('mp4a', mp4aData);
      const stsdHeader = new Uint8Array(4);
      new DataView(stsdHeader.buffer).setUint32(0, 1);
      return createFullBox('stsd', 0, 0, stsdHeader, mp4a);
    }
    
    buildEsds() {
      // Build AudioSpecificConfig based on detected parameters
      const SAMPLE_RATE_INDEX = {
        96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5,
        24000: 6, 22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11, 7350: 12
      };
      
      const sampleRate = this.audioTimescale;
      const channels = this.parser.audioChannels || 2;
      const samplingFreqIndex = SAMPLE_RATE_INDEX[sampleRate] ?? 4; // Default to 44100
      
      // AudioSpecificConfig: 5 bits objType + 4 bits freqIndex + 4 bits channels + 3 bits padding
      // AAC-LC = 2
      const audioConfig = ((2 << 11) | (samplingFreqIndex << 7) | (channels << 3)) & 0xFFFF;
      const audioConfigHigh = (audioConfig >> 8) & 0xFF;
      const audioConfigLow = audioConfig & 0xFF;
      
      const data = new Uint8Array([
        0x00, 0x00, 0x00, 0x00,  // version/flags
        0x03, 0x19,              // ES_Descriptor tag + length
        0x00, 0x02,              // ES_ID
        0x00,                    // flags
        0x04, 0x11,              // DecoderConfigDescriptor tag + length
        0x40,                    // objectTypeIndication (AAC)
        0x15,                    // streamType (audio) + upstream + reserved
        0x00, 0x00, 0x00,        // bufferSizeDB
        0x00, 0x01, 0xF4, 0x00,  // maxBitrate
        0x00, 0x01, 0xF4, 0x00,  // avgBitrate
        0x05, 0x02,              // DecoderSpecificInfo tag + length
        audioConfigHigh, audioConfigLow,  // AudioSpecificConfig
        0x06, 0x01, 0x02         // SLConfigDescriptor
      ]);
      return createBox('esds', data);
    }
    
    buildAudioStts() {
      // Use actual PTS differences for accurate timing (like video does)
      const audioPts = this.parser.audioPts;
      
      // If we don't have PTS data, fall back to constant duration
      if (audioPts.length < 2) {
        const data = new Uint8Array(12);
        const view = new DataView(data.buffer);
        view.setUint32(0, 1); 
        view.setUint32(4, this.audioSampleSizes.length); 
        view.setUint32(8, this.audioSampleDuration);
        return createFullBox('stts', 0, 0, data);
      }
      
      // Convert 90kHz PTS to audio timescale (48kHz)
      // PTS is in 90kHz, we need durations in 48kHz
      const entries = [];
      let lastDuration = -1, count = 0;
      
      for (let i = 0; i < audioPts.length; i++) {
        let duration;
        if (i < audioPts.length - 1) {
          // Calculate actual duration from PTS difference
          const ptsDiff = audioPts[i + 1] - audioPts[i];
          // Convert from 90kHz to 48kHz: duration = ptsDiff * 48000 / 90000
          duration = Math.round(ptsDiff * this.audioTimescale / 90000);
        } else {
          // Last frame - use standard AAC frame duration
          duration = this.audioSampleDuration;
        }
        
        // Clamp to reasonable values (handle discontinuities)
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
  
  /**
   * Get codec info for a stream type
   */
  function getCodecInfo(streamType) {
    return STREAM_TYPES[streamType] || { name: `Unknown (0x${streamType?.toString(16)})`, supported: false };
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
    const log = options.onProgress || (() => {});
    
    const parser = new TSParser();
    parser.parse(tsData);
    parser.finalize();
    
    const debug = parser.debug;
    const videoInfo = getCodecInfo(parser.videoStreamType);
    const audioInfo = getCodecInfo(parser.audioStreamType);
    
    // Log parsing results
    log(`Parsed ${debug.packets} TS packets`);
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
    
    log(`Frames: ${parser.videoAccessUnits.length} video, ${parser.audioAccessUnits.length} audio`);
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
      
      log(`Clipped: ${clipResult.actualStartTime.toFixed(2)}s - ${clipResult.actualEndTime.toFixed(2)}s (${clipResult.video.length} video, ${clipResult.audio.length} audio frames)`);
    }
    
    const builder = new MP4Builder(parser);
    const { width, height } = builder.getVideoDimensions();
    log(`Dimensions: ${width}x${height}`);
    
    return builder.build();
  }
  
  default convertTsToMp4;

  // ============================================
  // fMP4 to MP4 Converter  
  // ============================================
  /**
   * Fragmented MP4 to Standard MP4 Converter
   * Pure JavaScript - no dependencies
   */
  
  // ============================================
  // Box Utilities
  // ============================================
  function parseBoxes(data, offset = 0, end = data.byteLength) {
    const boxes = [];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    while (offset < end) {
      if (offset + 8 > end) break;
      const size = view.getUint32(offset);
      const type = String.fromCharCode(data[offset+4], data[offset+5], data[offset+6], data[offset+7]);
      if (size === 0 || size < 8) break;
      boxes.push({ type, offset, size, data: data.subarray(offset, offset + size) });
      offset += size;
    }
    return boxes;
  }
  
  function findBox(boxes, type) {
    for (const box of boxes) if (box.type === type) return box;
    return null;
  }
  
  function parseChildBoxes(box, headerSize = 8) {
    return parseBoxes(box.data, headerSize, box.size);
  }
  
  function createBox(type, ...payloads) {
    let size = 8;
    for (const p of payloads) size += p.byteLength;
    const result = new Uint8Array(size);
    const view = new DataView(result.buffer);
    view.setUint32(0, size);
    result[4] = type.charCodeAt(0); result[5] = type.charCodeAt(1); result[6] = type.charCodeAt(2); result[7] = type.charCodeAt(3);
    let offset = 8;
    for (const p of payloads) { result.set(p, offset); offset += p.byteLength; }
    return result;
  }
  
  // ============================================
  // trun/tfhd Parsing
  // ============================================
  function parseTrunWithOffset(trunData) {
    const view = new DataView(trunData.buffer, trunData.byteOffset, trunData.byteLength);
    const version = trunData[8];
    const flags = (trunData[9] << 16) | (trunData[10] << 8) | trunData[11];
    const sampleCount = view.getUint32(12);
    let offset = 16, dataOffset = 0;
    if (flags & 0x1) { dataOffset = view.getInt32(offset); offset += 4; }
    if (flags & 0x4) offset += 4;
    const samples = [];
    for (let i = 0; i < sampleCount; i++) {
      const sample = {};
      if (flags & 0x100) { sample.duration = view.getUint32(offset); offset += 4; }
      if (flags & 0x200) { sample.size = view.getUint32(offset); offset += 4; }
      if (flags & 0x400) { sample.flags = view.getUint32(offset); offset += 4; }
      if (flags & 0x800) { sample.compositionTimeOffset = version === 0 ? view.getUint32(offset) : view.getInt32(offset); offset += 4; }
      samples.push(sample);
    }
    return { samples, dataOffset };
  }
  
  function parseTfhd(tfhdData) {
    return new DataView(tfhdData.buffer, tfhdData.byteOffset, tfhdData.byteLength).getUint32(12);
  }
  
  // ============================================
  // Moov Rebuilding
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
        const type = String.fromCharCode(output[pos+4], output[pos+5], output[pos+6], output[pos+7]);
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
              const trackId = parseTfhd(tfhd.data);
              const { samples, dataOffset } = parseTrunWithOffset(trun.data);
              if (!tracks.has(trackId)) tracks.set(trackId, { samples: [], chunkOffsets: [] });
              const track = tracks.get(trackId);
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
  toMp4.version = '1.0.4';

  return toMp4;
});
