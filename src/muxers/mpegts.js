/**
 * MPEG-TS Muxer
 * 
 * Creates MPEG-TS container from H.264 video and AAC audio.
 * Converts WebCodecs encoder output (AVCC format) to MPEG-TS with Annex B NAL units.
 * 
 * @example
 * import { TSMuxer } from 'tomp4';
 * 
 * const muxer = new TSMuxer();
 * muxer.setSpsPps(sps, pps);
 * muxer.setHasAudio(true);
 * 
 * // Add audio samples (ADTS format)
 * muxer.addAudioSample(adtsData, pts90k);
 * 
 * // Add video samples (AVCC format from WebCodecs)
 * muxer.addVideoSample(avccData, isKeyframe, pts90k);
 * 
 * // Finalize and get output
 * muxer.flush();
 * const tsData = muxer.build();
 * 
 * @module muxers/mpegts
 */

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

// ============================================
// MPEG-TS Muxer
// ============================================

/**
 * MPEG-TS Muxer for H.264 video and AAC audio
 */
export class TSMuxer {
  constructor() {
    this.packets = [];
    this.cc = { pat: 0, pmt: 0, video: 0, audio: 0 };
    this.sps = null;
    this.pps = null;
    this.hasAudio = false;
    this.pendingAudio = [];
  }
  
  /**
   * Set SPS/PPS from encoder output
   * @param {Uint8Array} sps - Sequence Parameter Set
   * @param {Uint8Array} pps - Picture Parameter Set
   */
  setSpsPps(sps, pps) {
    this.sps = new Uint8Array(sps);
    this.pps = new Uint8Array(pps);
  }
  
  /**
   * Enable audio track in PMT
   * @param {boolean} hasAudio
   */
  setHasAudio(hasAudio) {
    this.hasAudio = hasAudio;
  }
  
  /**
   * Add AAC audio frame (ADTS format)
   * @param {Uint8Array} adtsData - ADTS-wrapped AAC frame
   * @param {number} pts90k - Presentation timestamp in 90kHz ticks
   */
  addAudioSample(adtsData, pts90k) {
    this.pendingAudio.push({ data: new Uint8Array(adtsData), pts: pts90k });
  }
  
  /**
   * Add H.264 video sample from WebCodecs encoder (AVCC format with length prefixes)
   * @param {Uint8Array} avccData - AVCC-formatted NAL units
   * @param {boolean} isKey - Is this a keyframe
   * @param {number} pts90k - Presentation timestamp in 90kHz ticks
   * @param {number} [dts90k] - Decode timestamp in 90kHz ticks (defaults to pts90k)
   */
  addVideoSample(avccData, isKey, pts90k, dts90k = pts90k) {
    const nalUnits = [];
    
    // Add AUD (Access Unit Delimiter) at start of each access unit
    nalUnits.push(new Uint8Array([0, 0, 0, 1, 0x09, 0xF0]));
    
    // If keyframe, prepend SPS/PPS
    if (isKey && this.sps && this.pps) {
      nalUnits.push(new Uint8Array([0, 0, 0, 1]));
      nalUnits.push(this.sps);
      nalUnits.push(new Uint8Array([0, 0, 0, 1]));
      nalUnits.push(this.pps);
    }
    
    // Parse AVCC NALs and convert to Annex B
    let offset = 0;
    let iterations = 0;
    const maxIterations = 10000;
    
    while (offset + 4 <= avccData.length && iterations < maxIterations) {
      iterations++;
      const len = (avccData[offset] << 24) | (avccData[offset + 1] << 16) | 
                  (avccData[offset + 2] << 8) | avccData[offset + 3];
      offset += 4;
      
      // Safety: bail on invalid NAL length
      if (len <= 0 || len > avccData.length - offset) {
        break;
      }
      
      nalUnits.push(new Uint8Array([0, 0, 0, 1]));
      nalUnits.push(avccData.slice(offset, offset + len));
      offset += len;
    }
    
    // Build PES packet with both PTS and DTS
    const annexB = concat(nalUnits);
    const pes = this._buildVideoPES(annexB, pts90k, dts90k);
    
    // Write PAT/PMT before keyframes
    if (isKey) {
      this.packets.push(this._buildPAT());
      this.packets.push(this._buildPMT());
    }
    
    // Write pending audio with PTS <= this video frame
    while (this.pendingAudio.length > 0 && this.pendingAudio[0].pts <= pts90k) {
      const audio = this.pendingAudio.shift();
      const audioPes = this._buildAudioPES(audio.data, audio.pts);
      this._packetizePES(audioPes, 0x102, false, audio.pts, 'audio');
    }
    
    // Packetize video PES into 188-byte TS packets (use DTS for PCR)
    this._packetizePES(pes, 0x101, isKey, dts90k, 'video');
  }
  
  /**
   * Flush remaining audio samples
   */
  flush() {
    while (this.pendingAudio.length > 0) {
      const audio = this.pendingAudio.shift();
      const audioPes = this._buildAudioPES(audio.data, audio.pts);
      this._packetizePES(audioPes, 0x102, false, audio.pts, 'audio');
    }
  }
  
  /**
   * Build final MPEG-TS data
   * @returns {Uint8Array}
   */
  build() {
    const total = this.packets.length * 188;
    const result = new Uint8Array(total);
    for (let i = 0; i < this.packets.length; i++) {
      result.set(this.packets[i], i * 188);
    }
    return result;
  }
  
  // --- Private methods ---
  
  _buildVideoPES(payload, pts90k, dts90k) {
    // If PTS == DTS, only write PTS (saves 5 bytes per frame)
    const hasDts = pts90k !== dts90k;
    const headerLen = hasDts ? 10 : 5;
    const pes = new Uint8Array(9 + headerLen + payload.length);
    
    pes[0] = 0; pes[1] = 0; pes[2] = 1; // Start code
    pes[3] = 0xE0; // Stream ID (video)
    pes[4] = 0; pes[5] = 0; // Length = 0 (unbounded)
    pes[6] = 0x80; // Flags: data_alignment
    
    if (hasDts) {
      // PTS + DTS present
      pes[7] = 0xC0; // PTS_DTS_flags = 11
      pes[8] = 10;   // Header length: 5 (PTS) + 5 (DTS)
      this._writePTS(pes, 9, pts90k, 0x31);  // PTS marker = 0011
      this._writePTS(pes, 14, dts90k, 0x11); // DTS marker = 0001
      pes.set(payload, 19);
    } else {
      // PTS only
      pes[7] = 0x80; // PTS_DTS_flags = 10
      pes[8] = 5;    // Header length: 5 (PTS)
      this._writePTS(pes, 9, pts90k, 0x21);  // PTS marker = 0010
      pes.set(payload, 14);
    }
    
    return pes;
  }
  
  _buildAudioPES(payload, pts90k) {
    const pes = new Uint8Array(14 + payload.length);
    pes[0] = 0; pes[1] = 0; pes[2] = 1; // Start code
    pes[3] = 0xC0; // Stream ID (audio)
    const pesLen = 3 + 5 + payload.length;
    pes[4] = (pesLen >> 8) & 0xFF;
    pes[5] = pesLen & 0xFF;
    pes[6] = 0x80;
    pes[7] = 0x80; // PTS present
    pes[8] = 5;
    this._writePTS(pes, 9, pts90k, 0x21);
    pes.set(payload, 14);
    return pes;
  }
  
  _writePTS(buf, offset, pts90k, marker) {
    const pts = BigInt(pts90k);
    buf[offset] = marker | ((Number(pts >> 30n) & 0x07) << 1);
    buf[offset + 1] = Number((pts >> 22n) & 0xFFn);
    buf[offset + 2] = ((Number((pts >> 15n) & 0x7Fn) << 1) | 1);
    buf[offset + 3] = Number((pts >> 7n) & 0xFFn);
    buf[offset + 4] = ((Number(pts & 0x7Fn) << 1) | 1);
  }
  
  _packetizePES(pes, pid, isKey, pts90k, type) {
    let offset = 0;
    let first = true;
    const cc = type === 'audio' ? 'audio' : 'video';
    
    while (offset < pes.length) {
      const pkt = new Uint8Array(188);
      pkt[0] = 0x47; // Sync byte
      
      const payloadStart = first ? 1 : 0;
      pkt[1] = (payloadStart << 6) | ((pid >> 8) & 0x1F);
      pkt[2] = pid & 0xFF;
      
      const remaining = pes.length - offset;
      
      // First packet of video keyframe gets adaptation field with PCR + RAI
      if (first && isKey && type === 'video') {
        const afLen = 7;
        const payloadSpace = 188 - 4 - 1 - afLen;
        const payloadLen = Math.min(remaining, payloadSpace);
        
        pkt[3] = 0x30 | (this.cc[cc] & 0x0F);
        pkt[4] = afLen;
        pkt[5] = 0x50; // PCR flag + random_access_indicator
        
        // PCR = 33-bit base (90kHz) + 6 reserved bits + 9-bit extension (27MHz)
        // We only use the base, extension = 0
        const pcrBase = BigInt(pts90k);
        pkt[6] = Number((pcrBase >> 25n) & 0xFFn);
        pkt[7] = Number((pcrBase >> 17n) & 0xFFn);
        pkt[8] = Number((pcrBase >> 9n) & 0xFFn);
        pkt[9] = Number((pcrBase >> 1n) & 0xFFn);
        pkt[10] = (Number(pcrBase & 1n) << 7) | 0x7E; // LSB of base + 6 reserved (111111) 
        pkt[11] = 0; // 9-bit extension = 0
        
        pkt.set(pes.slice(offset, offset + payloadLen), 12);
        offset += payloadLen;
      } else if (remaining < 184) {
        // Need stuffing
        const payloadLen = remaining;
        const afLen = 184 - payloadLen - 1;
        
        pkt[3] = 0x30 | (this.cc[cc] & 0x0F);
        pkt[4] = afLen;
        if (afLen > 0) {
          pkt[5] = 0x00;
          for (let i = 6; i < 5 + afLen; i++) pkt[i] = 0xFF;
        }
        pkt.set(pes.slice(offset, offset + payloadLen), 4 + 1 + afLen);
        offset += payloadLen;
      } else {
        // Full payload, no adaptation field
        pkt[3] = 0x10 | (this.cc[cc] & 0x0F);
        pkt.set(pes.slice(offset, offset + 184), 4);
        offset += 184;
      }
      
      this.cc[cc] = (this.cc[cc] + 1) & 0x0F;
      this.packets.push(pkt);
      first = false;
    }
  }
  
  _buildPAT() {
    const pkt = new Uint8Array(188);
    pkt[0] = 0x47;
    pkt[1] = 0x40;
    pkt[2] = 0x00;
    pkt[3] = 0x10 | (this.cc.pat & 0x0F);
    this.cc.pat = (this.cc.pat + 1) & 0x0F;
    
    pkt[4] = 0; // Pointer
    pkt[5] = 0x00; // table_id
    pkt[6] = 0xB0;
    pkt[7] = 13; // section_length
    pkt[8] = 0x00; pkt[9] = 0x01; // transport_stream_id
    pkt[10] = 0xC1;
    pkt[11] = 0x00;
    pkt[12] = 0x00;
    pkt[13] = 0x00; pkt[14] = 0x01; // program_number
    pkt[15] = 0xE1; pkt[16] = 0x00; // PMT PID = 0x100
    const crc = this._crc32(pkt.slice(5, 17));
    pkt[17] = (crc >> 24) & 0xFF;
    pkt[18] = (crc >> 16) & 0xFF;
    pkt[19] = (crc >> 8) & 0xFF;
    pkt[20] = crc & 0xFF;
    pkt.fill(0xFF, 21);
    return pkt;
  }
  
  _buildPMT() {
    const pkt = new Uint8Array(188);
    pkt[0] = 0x47;
    pkt[1] = 0x41; // PID 0x100 MSB
    pkt[2] = 0x00;
    pkt[3] = 0x10 | (this.cc.pmt & 0x0F);
    this.cc.pmt = (this.cc.pmt + 1) & 0x0F;
    
    pkt[4] = 0; // Pointer
    pkt[5] = 0x02; // table_id
    pkt[6] = 0xB0;
    
    if (this.hasAudio) {
      pkt[7] = 23; // section_length with audio
      pkt[8] = 0x00; pkt[9] = 0x01;
      pkt[10] = 0xC1;
      pkt[11] = 0x00;
      pkt[12] = 0x00;
      pkt[13] = 0xE1; pkt[14] = 0x01; // PCR_PID = 0x101
      pkt[15] = 0xF0; pkt[16] = 0x00;
      // Video stream (H.264)
      pkt[17] = 0x1B;
      pkt[18] = 0xE1; pkt[19] = 0x01; // PID 0x101
      pkt[20] = 0xF0; pkt[21] = 0x00;
      // Audio stream (AAC)
      pkt[22] = 0x0F;
      pkt[23] = 0xE1; pkt[24] = 0x02; // PID 0x102
      pkt[25] = 0xF0; pkt[26] = 0x00;
      const crc = this._crc32(pkt.slice(5, 27));
      pkt[27] = (crc >> 24) & 0xFF;
      pkt[28] = (crc >> 16) & 0xFF;
      pkt[29] = (crc >> 8) & 0xFF;
      pkt[30] = crc & 0xFF;
      pkt.fill(0xFF, 31);
    } else {
      pkt[7] = 18; // section_length video only
      pkt[8] = 0x00; pkt[9] = 0x01;
      pkt[10] = 0xC1;
      pkt[11] = 0x00;
      pkt[12] = 0x00;
      pkt[13] = 0xE1; pkt[14] = 0x01;
      pkt[15] = 0xF0; pkt[16] = 0x00;
      pkt[17] = 0x1B;
      pkt[18] = 0xE1; pkt[19] = 0x01;
      pkt[20] = 0xF0; pkt[21] = 0x00;
      const crc = this._crc32(pkt.slice(5, 22));
      pkt[22] = (crc >> 24) & 0xFF;
      pkt[23] = (crc >> 16) & 0xFF;
      pkt[24] = (crc >> 8) & 0xFF;
      pkt[25] = crc & 0xFF;
      pkt.fill(0xFF, 26);
    }
    return pkt;
  }
  
  _crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i] << 24;
      for (let j = 0; j < 8; j++) {
        crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04C11DB7) : (crc << 1);
      }
    }
    return crc >>> 0;
  }
}

export default TSMuxer;



