/**
 * MP4 Parser
 * 
 * Parse MP4 files to extract tracks, samples, and metadata.
 * Works with both local data (Uint8Array) and can be extended for remote sources.
 * 
 * @example
 * // Parse local MP4 data
 * const parser = new MP4Parser(uint8ArrayData);
 * console.log(parser.duration, parser.videoTrack, parser.audioTrack);
 * 
 * // Get sample table for a track
 * const samples = parser.getVideoSamples();
 * 
 * // Build HLS segments
 * const segments = parser.buildSegments(4); // 4 second segments
 * 
 * @module parsers/mp4
 */

// ============================================================================
// Binary Reading Utilities
// ============================================================================

export function readUint32(data, offset) {
  return (data[offset] << 24) | (data[offset + 1] << 16) | 
         (data[offset + 2] << 8) | data[offset + 3];
}

export function readUint64(data, offset) {
  // For simplicity, only handle lower 32 bits (files < 4GB)
  return readUint32(data, offset + 4);
}

export function readInt32(data, offset) {
  const val = readUint32(data, offset);
  return (val & 0x80000000) ? val - 0x100000000 : val;
}

export function boxType(data, offset) {
  return String.fromCharCode(
    data[offset], data[offset + 1], 
    data[offset + 2], data[offset + 3]
  );
}

// ============================================================================
// Box Finding
// ============================================================================

/**
 * Find a box by type within a data range
 * @param {Uint8Array} data - MP4 data
 * @param {string} type - 4-character box type (e.g., 'moov', 'trak')
 * @param {number} start - Start offset
 * @param {number} end - End offset
 * @returns {object|null} Box info {offset, size, headerSize} or null
 */
export function findBox(data, type, start = 0, end = data.length) {
  let offset = start;
  while (offset < end - 8) {
    const size = readUint32(data, offset);
    const btype = boxType(data, offset + 4);
    
    if (size === 0 || size > end - offset) break;
    
    const headerSize = size === 1 ? 16 : 8;
    const actualSize = size === 1 ? readUint64(data, offset + 8) : size;
    
    if (btype === type) {
      return { offset, size: actualSize, headerSize };
    }
    offset += actualSize;
  }
  return null;
}

/**
 * Find all boxes of a type within a data range
 */
export function findAllBoxes(data, type, start = 0, end = data.length) {
  const boxes = [];
  let offset = start;
  while (offset < end - 8) {
    const size = readUint32(data, offset);
    const btype = boxType(data, offset + 4);
    
    if (size === 0 || size > end - offset) break;
    
    const headerSize = size === 1 ? 16 : 8;
    const actualSize = size === 1 ? readUint64(data, offset + 8) : size;
    
    if (btype === type) {
      boxes.push({ offset, size: actualSize, headerSize });
    }
    offset += actualSize;
  }
  return boxes;
}

// ============================================================================
// Sample Table Box Parsing
// ============================================================================

/**
 * Parse stts (time-to-sample) box
 */
export function parseStts(data, offset) {
  const entryCount = readUint32(data, offset + 12);
  const entries = [];
  let pos = offset + 16;
  for (let i = 0; i < entryCount; i++) {
    entries.push({
      sampleCount: readUint32(data, pos),
      sampleDelta: readUint32(data, pos + 4)
    });
    pos += 8;
  }
  return entries;
}

/**
 * Parse stss (sync sample / keyframe) box
 */
export function parseStss(data, offset) {
  const entryCount = readUint32(data, offset + 12);
  const keyframes = [];
  let pos = offset + 16;
  for (let i = 0; i < entryCount; i++) {
    keyframes.push(readUint32(data, pos));
    pos += 4;
  }
  return keyframes;
}

/**
 * Parse stsz (sample size) box
 */
export function parseStsz(data, offset) {
  const sampleSize = readUint32(data, offset + 12);
  const sampleCount = readUint32(data, offset + 16);
  
  if (sampleSize !== 0) {
    return Array(sampleCount).fill(sampleSize);
  }
  
  const sizes = [];
  let pos = offset + 20;
  for (let i = 0; i < sampleCount; i++) {
    sizes.push(readUint32(data, pos));
    pos += 4;
  }
  return sizes;
}

/**
 * Parse stco (chunk offset 32-bit) box
 */
export function parseStco(data, offset) {
  const entryCount = readUint32(data, offset + 12);
  const offsets = [];
  let pos = offset + 16;
  for (let i = 0; i < entryCount; i++) {
    offsets.push(readUint32(data, pos));
    pos += 4;
  }
  return offsets;
}

/**
 * Parse co64 (chunk offset 64-bit) box
 */
export function parseCo64(data, offset) {
  const entryCount = readUint32(data, offset + 12);
  const offsets = [];
  let pos = offset + 16;
  for (let i = 0; i < entryCount; i++) {
    offsets.push(readUint64(data, pos));
    pos += 8;
  }
  return offsets;
}

/**
 * Parse stsc (sample-to-chunk) box
 */
export function parseStsc(data, offset) {
  const entryCount = readUint32(data, offset + 12);
  const entries = [];
  let pos = offset + 16;
  for (let i = 0; i < entryCount; i++) {
    entries.push({
      firstChunk: readUint32(data, pos),
      samplesPerChunk: readUint32(data, pos + 4),
      sampleDescriptionIndex: readUint32(data, pos + 8)
    });
    pos += 12;
  }
  return entries;
}

/**
 * Parse ctts (composition time offset) box for B-frames
 */
export function parseCtts(data, offset) {
  const version = data[offset + 8];
  const entryCount = readUint32(data, offset + 12);
  const entries = [];
  let pos = offset + 16;
  for (let i = 0; i < entryCount; i++) {
    const sampleCount = readUint32(data, pos);
    let sampleOffset;
    if (version === 0) {
      sampleOffset = readUint32(data, pos + 4);
    } else {
      // Version 1: signed offset
      sampleOffset = readInt32(data, pos + 4);
    }
    entries.push({ sampleCount, sampleOffset });
    pos += 8;
  }
  return entries;
}

/**
 * Parse mdhd (media header) box
 */
export function parseMdhd(data, offset) {
  const version = data[offset + 8];
  if (version === 0) {
    return {
      timescale: readUint32(data, offset + 20),
      duration: readUint32(data, offset + 24)
    };
  }
  return {
    timescale: readUint32(data, offset + 28),
    duration: readUint64(data, offset + 32)
  };
}

/**
 * Parse tkhd (track header) box
 */
export function parseTkhd(data, offset) {
  const version = data[offset + 8];
  if (version === 0) {
    return {
      trackId: readUint32(data, offset + 20),
      duration: readUint32(data, offset + 28),
      width: readUint32(data, offset + 84) / 65536,
      height: readUint32(data, offset + 88) / 65536
    };
  }
  return {
    trackId: readUint32(data, offset + 28),
    duration: readUint64(data, offset + 36),
    width: readUint32(data, offset + 96) / 65536,
    height: readUint32(data, offset + 100) / 65536
  };
}

/**
 * Parse avcC (AVC decoder configuration) box
 */
export function parseAvcC(data, offset) {
  let pos = offset + 8;
  const configVersion = data[pos++];
  const profile = data[pos++];
  const profileCompat = data[pos++];
  const level = data[pos++];
  const lengthSizeMinusOne = data[pos++] & 0x03;
  const numSPS = data[pos++] & 0x1F;
  
  const sps = [];
  for (let i = 0; i < numSPS; i++) {
    const spsLen = (data[pos] << 8) | data[pos + 1];
    pos += 2;
    sps.push(data.slice(pos, pos + spsLen));
    pos += spsLen;
  }
  
  const numPPS = data[pos++];
  const pps = [];
  for (let i = 0; i < numPPS; i++) {
    const ppsLen = (data[pos] << 8) | data[pos + 1];
    pos += 2;
    pps.push(data.slice(pos, pos + ppsLen));
    pos += ppsLen;
  }
  
  return { 
    profile, 
    level, 
    sps, 
    pps, 
    nalLengthSize: lengthSizeMinusOne + 1 
  };
}

/**
 * Parse mp4a audio sample entry for sample rate and channels
 */
export function parseMp4a(data, offset) {
  const channels = (data[offset + 24] << 8) | data[offset + 25];
  const sampleRate = (data[offset + 32] << 8) | data[offset + 33];
  return { channels, sampleRate };
}

// ============================================================================
// Track Analysis
// ============================================================================

/**
 * Analyze a single track from moov data
 */
export function analyzeTrack(moov, trakOffset, trakSize) {
  // Get track header
  const tkhd = findBox(moov, 'tkhd', trakOffset + 8, trakOffset + trakSize);
  const tkhdInfo = tkhd ? parseTkhd(moov, tkhd.offset) : { trackId: 0, width: 0, height: 0 };
  
  const mdia = findBox(moov, 'mdia', trakOffset + 8, trakOffset + trakSize);
  if (!mdia) return null;
  
  const mdhd = findBox(moov, 'mdhd', mdia.offset + 8, mdia.offset + mdia.size);
  const mediaInfo = mdhd ? parseMdhd(moov, mdhd.offset) : { timescale: 90000, duration: 0 };
  
  const hdlr = findBox(moov, 'hdlr', mdia.offset + 8, mdia.offset + mdia.size);
  const handlerType = hdlr ? boxType(moov, hdlr.offset + 16) : 'unkn';
  
  const minf = findBox(moov, 'minf', mdia.offset + 8, mdia.offset + mdia.size);
  if (!minf) return null;
  
  const stbl = findBox(moov, 'stbl', minf.offset + 8, minf.offset + minf.size);
  if (!stbl) return null;
  
  const stblStart = stbl.offset + 8;
  const stblEnd = stbl.offset + stbl.size;
  
  // Parse sample tables
  const sttsBox = findBox(moov, 'stts', stblStart, stblEnd);
  const stssBox = findBox(moov, 'stss', stblStart, stblEnd);
  const stszBox = findBox(moov, 'stsz', stblStart, stblEnd);
  const stcoBox = findBox(moov, 'stco', stblStart, stblEnd);
  const co64Box = findBox(moov, 'co64', stblStart, stblEnd);
  const stscBox = findBox(moov, 'stsc', stblStart, stblEnd);
  const stsdBox = findBox(moov, 'stsd', stblStart, stblEnd);
  const cttsBox = findBox(moov, 'ctts', stblStart, stblEnd);
  
  // Parse codec config
  let codecConfig = null;
  let audioConfig = null;
  
  if (stsdBox && handlerType === 'vide') {
    const avc1 = findBox(moov, 'avc1', stsdBox.offset + 16, stsdBox.offset + stsdBox.size);
    if (avc1) {
      const avcC = findBox(moov, 'avcC', avc1.offset + 86, avc1.offset + avc1.size);
      if (avcC) {
        codecConfig = parseAvcC(moov, avcC.offset);
      }
    }
  }
  
  if (stsdBox && handlerType === 'soun') {
    const mp4a = findBox(moov, 'mp4a', stsdBox.offset + 16, stsdBox.offset + stsdBox.size);
    if (mp4a) {
      audioConfig = parseMp4a(moov, mp4a.offset);
    }
  }
  
  return {
    trackId: tkhdInfo.trackId,
    type: handlerType,
    width: tkhdInfo.width,
    height: tkhdInfo.height,
    timescale: mediaInfo.timescale,
    duration: mediaInfo.duration,
    durationSeconds: mediaInfo.duration / mediaInfo.timescale,
    stts: sttsBox ? parseStts(moov, sttsBox.offset) : [],
    stss: stssBox ? parseStss(moov, stssBox.offset) : [],
    stsz: stszBox ? parseStsz(moov, stszBox.offset) : [],
    stco: stcoBox ? parseStco(moov, stcoBox.offset) : 
          co64Box ? parseCo64(moov, co64Box.offset) : [],
    stsc: stscBox ? parseStsc(moov, stscBox.offset) : [],
    ctts: cttsBox ? parseCtts(moov, cttsBox.offset) : [],
    codecConfig,
    audioConfig
  };
}

// ============================================================================
// Sample Table Building
// ============================================================================

/**
 * Build a flat sample table with byte offsets and timestamps
 * @param {object} track - Track metadata from analyzeTrack
 * @returns {Array} Array of sample objects
 */
export function buildSampleTable(track) {
  const { stsz, stco, stsc, stts, stss, ctts, timescale } = track;
  const samples = [];
  
  // Build ctts lookup (composition time offset for B-frames)
  const cttsOffsets = [];
  if (ctts && ctts.length > 0) {
    for (const entry of ctts) {
      for (let i = 0; i < entry.sampleCount; i++) {
        cttsOffsets.push(entry.sampleOffset);
      }
    }
  }
  
  let sampleIndex = 0;
  let currentDts = 0;
  let sttsEntryIndex = 0;
  let sttsRemaining = stts[0]?.sampleCount || 0;
  
  for (let chunkIndex = 0; chunkIndex < stco.length; chunkIndex++) {
    // Find samples per chunk for this chunk
    let samplesInChunk = 1;
    for (let i = stsc.length - 1; i >= 0; i--) {
      if (stsc[i].firstChunk <= chunkIndex + 1) {
        samplesInChunk = stsc[i].samplesPerChunk;
        break;
      }
    }
    
    let chunkOffset = stco[chunkIndex];
    
    for (let s = 0; s < samplesInChunk && sampleIndex < stsz.length; s++) {
      const size = stsz[sampleIndex];
      const duration = stts[sttsEntryIndex]?.sampleDelta || 0;
      
      // PTS = DTS + composition offset (ctts)
      const compositionOffset = cttsOffsets[sampleIndex] || 0;
      const pts = Math.max(currentDts, currentDts + compositionOffset);
      
      samples.push({
        index: sampleIndex,
        offset: chunkOffset,
        size,
        dts: currentDts / timescale,
        pts: pts / timescale,
        time: pts / timescale,
        duration: duration / timescale,
        isKeyframe: stss.length === 0 || stss.includes(sampleIndex + 1)
      });
      
      chunkOffset += size;
      currentDts += duration;
      sampleIndex++;
      
      sttsRemaining--;
      if (sttsRemaining === 0 && sttsEntryIndex < stts.length - 1) {
        sttsEntryIndex++;
        sttsRemaining = stts[sttsEntryIndex].sampleCount;
      }
    }
  }
  
  return samples;
}

/**
 * Build HLS-style segments from video samples
 * @param {Array} videoSamples - Video sample table
 * @param {number} targetDuration - Target segment duration in seconds
 * @returns {Array} Array of segment definitions
 */
export function buildSegments(videoSamples, targetDuration = 4) {
  const segments = [];
  const keyframes = videoSamples.filter(s => s.isKeyframe);
  
  for (let i = 0; i < keyframes.length; i++) {
    const start = keyframes[i];
    const end = keyframes[i + 1] || videoSamples[videoSamples.length - 1];
    
    const videoStart = start.index;
    const videoEnd = end ? end.index : videoSamples.length;
    
    const duration = (end ? end.time : 
      videoSamples[videoSamples.length - 1].time + 
      videoSamples[videoSamples.length - 1].duration) - start.time;
    
    // Combine short segments
    if (segments.length > 0 && 
        segments[segments.length - 1].duration + duration < targetDuration) {
      const prev = segments[segments.length - 1];
      prev.videoEnd = videoEnd;
      prev.duration += duration;
      prev.endTime = start.time + duration;
    } else {
      segments.push({
        index: segments.length,
        startTime: start.time,
        endTime: start.time + duration,
        duration,
        videoStart,
        videoEnd
      });
    }
  }
  
  return segments;
}

/**
 * Calculate byte ranges needed for a set of samples
 * @param {Array} samples - Array of samples with offset and size
 * @param {number} maxGap - Maximum gap to coalesce (default 64KB)
 * @returns {Array} Array of {start, end, samples} ranges
 */
export function calculateByteRanges(samples, maxGap = 65536) {
  if (samples.length === 0) return [];
  
  const ranges = [];
  let currentRange = {
    start: samples[0].offset,
    end: samples[0].offset + samples[0].size,
    samples: [samples[0]]
  };
  
  for (let i = 1; i < samples.length; i++) {
    const sample = samples[i];
    
    if (sample.offset <= currentRange.end + maxGap) {
      currentRange.end = Math.max(currentRange.end, sample.offset + sample.size);
      currentRange.samples.push(sample);
    } else {
      ranges.push(currentRange);
      currentRange = {
        start: sample.offset,
        end: sample.offset + sample.size,
        samples: [sample]
      };
    }
  }
  ranges.push(currentRange);
  
  return ranges;
}

// ============================================================================
// MP4Parser Class
// ============================================================================

/**
 * MP4 Parser - Parse MP4 files to extract tracks and samples
 */
export class MP4Parser {
  /**
   * Create parser from MP4 data
   * @param {Uint8Array} data - Complete MP4 file data
   */
  constructor(data) {
    this.data = data;
    this.moov = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.videoSamples = [];
    this.audioSamples = [];
    
    this._parse();
  }
  
  _parse() {
    // Find moov box
    const moov = findBox(this.data, 'moov');
    if (!moov) {
      throw new Error('No moov box found - not a valid MP4 file');
    }
    
    this.moov = this.data.slice(moov.offset, moov.offset + moov.size);
    
    // Parse tracks
    let trackOffset = 8;
    while (trackOffset < this.moov.length) {
      const trak = findBox(this.moov, 'trak', trackOffset);
      if (!trak) break;
      
      const track = analyzeTrack(this.moov, trak.offset, trak.size);
      if (track) {
        if (track.type === 'vide' && !this.videoTrack) {
          this.videoTrack = track;
          this.videoSamples = buildSampleTable(track);
        } else if (track.type === 'soun' && !this.audioTrack) {
          this.audioTrack = track;
          this.audioSamples = buildSampleTable(track);
        }
      }
      trackOffset = trak.offset + trak.size;
    }
    
    if (!this.videoTrack) {
      throw new Error('No video track found');
    }
  }
  
  /** Duration in seconds */
  get duration() {
    return this.videoTrack?.durationSeconds || 0;
  }
  
  /** Video width */
  get width() {
    return this.videoTrack?.width || 0;
  }
  
  /** Video height */
  get height() {
    return this.videoTrack?.height || 0;
  }
  
  /** Whether source has audio */
  get hasAudio() {
    return !!this.audioTrack;
  }
  
  /** Whether video has B-frames */
  get hasBframes() {
    return this.videoTrack?.ctts?.length > 0;
  }
  
  /** Video codec config (SPS/PPS) */
  get videoCodecConfig() {
    return this.videoTrack?.codecConfig;
  }
  
  /** Audio config (sample rate, channels) */
  get audioCodecConfig() {
    return this.audioTrack?.audioConfig;
  }
  
  /**
   * Get video samples
   * @returns {Array} Video sample table
   */
  getVideoSamples() {
    return this.videoSamples;
  }
  
  /**
   * Get audio samples
   * @returns {Array} Audio sample table
   */
  getAudioSamples() {
    return this.audioSamples;
  }
  
  /**
   * Build HLS-style segments
   * @param {number} targetDuration - Target segment duration in seconds
   * @returns {Array} Segment definitions
   */
  buildSegments(targetDuration = 4) {
    return buildSegments(this.videoSamples, targetDuration);
  }
  
  /**
   * Get sample data for a range of samples
   * @param {Array} samples - Samples to extract (must have offset and size)
   * @returns {Array} Samples with data property added
   */
  getSampleData(samples) {
    return samples.map(sample => ({
      ...sample,
      data: this.data.slice(sample.offset, sample.offset + sample.size)
    }));
  }
  
  /**
   * Get parser info
   */
  getInfo() {
    return {
      duration: this.duration,
      width: this.width,
      height: this.height,
      hasAudio: this.hasAudio,
      hasBframes: this.hasBframes,
      videoSampleCount: this.videoSamples.length,
      audioSampleCount: this.audioSamples.length,
      keyframeCount: this.videoTrack?.stss?.length || 
                     this.videoSamples.filter(s => s.isKeyframe).length
    };
  }
}

export default MP4Parser;

