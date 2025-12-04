/**
 * MPEG-TS Parser
 * 
 * Parses MPEG Transport Stream data and extracts video/audio access units.
 * Supports H.264/H.265 video and AAC audio.
 * 
 * @example
 * import { TSParser } from 'tomp4';
 * 
 * const parser = new TSParser();
 * parser.parse(tsData);
 * parser.finalize();
 * 
 * console.log(parser.videoAccessUnits.length); // Number of video frames
 * console.log(parser.audioAccessUnits.length); // Number of audio frames
 * 
 * @module parsers/mpegts
 */

// ============================================
// Constants
// ============================================

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;
const PAT_PID = 0x0000;

// Stream type info
export const STREAM_TYPES = {
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
// MPEG-TS Parser
// ============================================

/**
 * MPEG-TS Parser
 * Extracts video and audio access units from MPEG Transport Stream data.
 */
export class TSParser {
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
    this.lastAudioPts = null;
    this.adtsPartial = null;
    this.audioSampleRate = null;
    this.audioChannels = null;
    this.videoWidth = null;
    this.videoHeight = null;
    this.debug = { packets: 0, patFound: false, pmtFound: false };
  }
  
  /**
   * Parse MPEG-TS data
   * @param {Uint8Array} data - MPEG-TS data
   */
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
      if (payloadOffset >= TS_PACKET_SIZE) return;
    }
    if (adaptationField === 2) return;
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
    let offset = payload[0] + 1;
    if (offset + 8 > payload.length) return;
    
    offset += 8;
    
    while (offset + 4 <= payload.length - 4) {
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
    let offset = payload[0] + 1;
    if (offset + 12 > payload.length) return;
    
    offset++;
    const sectionLength = ((payload[offset] & 0x0F) << 8) | payload[offset + 1];
    offset += 2;
    offset += 5;
    offset += 2;
    
    if (offset + 2 > payload.length) return;
    const programInfoLength = ((payload[offset] & 0x0F) << 8) | payload[offset + 1];
    offset += 2 + programInfoLength;
    
    const sectionEnd = Math.min(payload.length - 4, 1 + payload[0] + 3 + sectionLength - 4);
    
    while (offset + 5 <= sectionEnd) {
      const streamType = payload[offset];
      const elementaryPid = ((payload[offset + 1] & 0x1F) << 8) | payload[offset + 2];
      const esInfoLength = ((payload[offset + 3] & 0x0F) << 8) | payload[offset + 4];
      
      if (!this.videoPid && (streamType === 0x01 || streamType === 0x02 || streamType === 0x1B || streamType === 0x24)) {
        this.videoPid = elementaryPid;
        this.videoStreamType = streamType;
        this.debug.pmtFound = true;
      }
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
    
    this.debug.audioPesCount = (this.debug.audioPesCount || 0) + 1;
    this.debug.audioFramesInPes = (this.debug.audioFramesInPes || 0) + frames.length;
    
    if (pts !== null) {
      this.lastAudioPts = pts;
    } else if (this.lastAudioPts !== null) {
      pts = this.lastAudioPts;
    } else {
      this.debug.audioSkipped = (this.debug.audioSkipped || 0) + frames.length;
      return;
    }
    
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
    const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    
    const frames = [];
    let i = 0;
    
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
  
  /**
   * Finalize parsing - process remaining buffers and normalize timestamps
   */
  finalize() {
    if (this.videoPesBuffer.length > 0) this.processPES(this.concatenateBuffers(this.videoPesBuffer), 'video');
    if (this.audioPesBuffer.length > 0) this.processPES(this.concatenateBuffers(this.audioPesBuffer), 'audio');
    
    this.normalizeTimestamps();
  }
  
  normalizeTimestamps() {
    let minPts = Infinity;
    
    if (this.videoPts.length > 0) {
      minPts = Math.min(minPts, Math.min(...this.videoPts));
    }
    if (this.audioPts.length > 0) {
      minPts = Math.min(minPts, Math.min(...this.audioPts));
    }
    
    if (minPts === Infinity || minPts === 0) return;
    
    for (let i = 0; i < this.videoPts.length; i++) {
      this.videoPts[i] -= minPts;
    }
    for (let i = 0; i < this.videoDts.length; i++) {
      this.videoDts[i] -= minPts;
    }
    for (let i = 0; i < this.audioPts.length; i++) {
      this.audioPts[i] -= minPts;
    }
    
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

/**
 * Get codec info for a stream type
 * @param {number} streamType - MPEG-TS stream type
 * @returns {object} Codec info with name and supported flag
 */
export function getCodecInfo(streamType) {
  return STREAM_TYPES[streamType] || { name: `Unknown (0x${streamType?.toString(16)})`, supported: false };
}

export default TSParser;

