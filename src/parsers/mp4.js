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
  // `>>> 0`: bitwise ops yield int32, which turned values >= 2^31 (box sizes,
  // stco offsets in files over 2 GB) negative.
  return ((data[offset] << 24) | (data[offset + 1] << 16) |
          (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

export function readUint64(data, offset) {
  // Exact up to 2^53 (9 PB) — co64 offsets in files over 4 GB need the high word.
  return readUint32(data, offset) * 0x100000000 + readUint32(data, offset + 4);
}

export function readInt32(data, offset) {
  const val = readUint32(data, offset);
  return val > 0x7FFFFFFF ? val - 0x100000000 : val;
}

export function readInt64(data, offset) {
  const hi = readInt32(data, offset);
  return hi * 0x100000000 + readUint32(data, offset + 4);
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
  const entryCount = readUint32(data, offset + 12);
  const entries = [];
  let pos = offset + 16;
  for (let i = 0; i < entryCount; i++) {
    const sampleCount = readUint32(data, pos);
    // Signed for both versions: version 0 is unsigned per spec, but files
    // with negative v0 offsets exist and ffmpeg and browsers read them signed.
    const sampleOffset = readInt32(data, pos + 4);
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
 * Parse mp4a audio sample entry for sample rate and channels, plus the
 * AudioSpecificConfig from its esds child when present.
 */
export function parseMp4a(data, offset) {
  const channels = (data[offset + 24] << 8) | data[offset + 25];
  const sampleRate = (data[offset + 32] << 8) | data[offset + 33];
  const size = readUint32(data, offset);
  // Sample entry: 8 header + 28 fields, then child boxes (esds).
  const esds = findBox(data, 'esds', offset + 36, offset + size);
  const config = esds ? parseEsds(data, esds.offset, esds.size) : null;
  const objectTypeIndication = config?.objectTypeIndication;
  const asc = config?.objectType !== undefined ? config : null;
  return {
    channels, sampleRate,
    ...(objectTypeIndication !== undefined ? { objectTypeIndication } : {}),
    ...(asc ? { asc } : {}),
  };
}

const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000,
  22050, 16000, 12000, 11025, 8000, 7350];

/** MPEG-4 Audio, MPEG-2 AAC Main / LC / SSR (objectTypeIndication). */
const AAC_OBJECT_TYPE_INDICATIONS = [0x40, 0x66, 0x67, 0x68];

/**
 * Parse an esds box down to the AAC AudioSpecificConfig (ISO 14496-1 / -3).
 * Non-AAC streams (e.g. MP3, 0x69/0x6B) return only their
 * `objectTypeIndication`.
 * @returns {{objectTypeIndication:number, objectType?:number,
 *   samplingFrequencyIndex?:number, sampleRate?:number,
 *   channelConfiguration?:number, bytes?:Uint8Array}|null}
 */
export function parseEsds(data, offset, size) {
  const end = offset + size;
  let pos = offset + 12; // box header + version/flags

  // Descriptor length: up to 4 bytes, 7 bits each.
  const readLen = () => {
    let len = 0;
    for (let i = 0; i < 4 && pos < end; i++) {
      const b = data[pos++];
      len = (len << 7) | (b & 0x7F);
      if (!(b & 0x80)) break;
    }
    return len;
  };

  let objectTypeIndication;
  while (pos < end) {
    const tag = data[pos++];
    const len = readLen();
    if (tag === 0x03) { // ES_Descriptor
      const flags = data[pos + 2];
      pos += 3;
      if (flags & 0x80) pos += 2;                 // dependsOn_ES_ID
      if (flags & 0x40) pos += 1 + data[pos];     // URL
      if (flags & 0x20) pos += 2;                 // OCR_ES_Id
    } else if (tag === 0x04) { // DecoderConfigDescriptor
      objectTypeIndication = data[pos];
      if (!AAC_OBJECT_TYPE_INDICATIONS.includes(objectTypeIndication)) return { objectTypeIndication };
      pos += 13;
    } else if (tag === 0x05) { // DecoderSpecificInfo = AudioSpecificConfig
      const bytes = data.slice(pos, pos + len);
      if (bytes.length < 2) return objectTypeIndication === undefined ? null : { objectTypeIndication };
      let bit = 0;
      const read = (n) => {
        let v = 0;
        for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
        return v;
      };
      let objectType = read(5);
      if (objectType === 31) objectType = 32 + read(6);
      const samplingFrequencyIndex = read(4);
      const sampleRate = samplingFrequencyIndex === 15 ? read(24) : AAC_SAMPLE_RATES[samplingFrequencyIndex];
      const channelConfiguration = read(4);
      return { objectTypeIndication, objectType, samplingFrequencyIndex, sampleRate, channelConfiguration, bytes };
    } else {
      pos += len;
    }
  }
  return objectTypeIndication === undefined ? null : { objectTypeIndication };
}

/**
 * Parse an elst (edit list) box.
 * @returns {Array<{segmentDuration:number, mediaTime:number, mediaRate:number}>}
 *   segmentDuration in movie timescale; mediaTime in media timescale (-1 = empty edit).
 */
export function parseElst(data, offset) {
  const version = data[offset + 8];
  const count = readUint32(data, offset + 12);
  const entries = [];
  let pos = offset + 16;
  for (let i = 0; i < count; i++) {
    if (version === 1) {
      entries.push({
        segmentDuration: readUint64(data, pos),
        mediaTime: readInt64(data, pos + 8),
        mediaRate: readInt32(data, pos + 16) / 65536,
      });
      pos += 20;
    } else {
      entries.push({
        segmentDuration: readUint32(data, pos),
        mediaTime: readInt32(data, pos + 4),
        mediaRate: readInt32(data, pos + 8) / 65536,
      });
      pos += 12;
    }
  }
  return entries;
}

/** Movie timescale from moov/mvhd (edit list durations use it). */
export function parseMvhdTimescale(moov) {
  const mvhd = findBox(moov, 'mvhd', 8);
  if (!mvhd) return 0;
  return moov[mvhd.offset + 8] === 1
    ? readUint32(moov, mvhd.offset + 28)
    : readUint32(moov, mvhd.offset + 20);
}

/**
 * Reduce an edit list to the common case: leading empty edits delay the track,
 * the first non-empty edit picks the media time presented at that point.
 * Presentation time = media time - mediaTime + emptyDuration (all seconds).
 */
export function summarizeEdits(entries, mediaTimescale, movieTimescale) {
  let emptyDuration = 0;
  let mediaTime = 0;
  for (const e of entries) {
    if (e.mediaTime === -1) {
      emptyDuration += movieTimescale ? e.segmentDuration / movieTimescale : 0;
      continue;
    }
    mediaTime = e.mediaTime / mediaTimescale;
    break;
  }
  return { emptyDuration, mediaTime, entryCount: entries.length };
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

  // Edit list (trak/edts/elst). Sample times below stay in media time; callers
  // that need presentation time apply `edit` (see summarizeEdits).
  const edts = findBox(moov, 'edts', trakOffset + 8, trakOffset + trakSize);
  const elst = edts ? findBox(moov, 'elst', edts.offset + 8, edts.offset + edts.size) : null;
  const edit = summarizeEdits(
    elst ? parseElst(moov, elst.offset) : [],
    mediaInfo.timescale,
    parseMvhdTimescale(moov),
  );

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
    audioConfig,
    edit
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
  
  // stss lists 1-based sync sample numbers; a Set keeps this O(n) — includes()
  // per sample was O(samples × keyframes) (≈64M checks for a 42-min 720p file).
  const syncSamples = stss.length > 0 ? new Set(stss) : null;

  let sampleIndex = 0;
  let currentDts = 0;
  let sttsEntryIndex = 0;
  let sttsRemaining = stts[0]?.sampleCount || 0;
  
  // stsc entries are sorted by firstChunk: walk them alongside the chunks.
  // (Scanning all entries per chunk was O(chunks × entries) — 2.5 s for an
  // interleaved 42-min audio track with 66k entries.)
  let stscIndex = -1;

  for (let chunkIndex = 0; chunkIndex < stco.length; chunkIndex++) {
    // Find samples per chunk for this chunk
    while (stscIndex + 1 < stsc.length && stsc[stscIndex + 1].firstChunk <= chunkIndex + 1) stscIndex++;
    const samplesInChunk = stscIndex >= 0 ? stsc[stscIndex].samplesPerChunk : 1;
    
    let chunkOffset = stco[chunkIndex];
    
    for (let s = 0; s < samplesInChunk && sampleIndex < stsz.length; s++) {
      const size = stsz[sampleIndex];
      const duration = stts[sttsEntryIndex]?.sampleDelta || 0;
      
      // PTS = DTS + composition offset (ctts). Version-1 ctts offsets may be
      // negative; they are kept (clamping to DTS broke B-frame order).
      const compositionOffset = cttsOffsets[sampleIndex] || 0;
      const pts = currentDts + compositionOffset;

      samples.push({
        index: sampleIndex,
        offset: chunkOffset,
        size,
        dts: currentDts / timescale,
        pts: pts / timescale,
        time: pts / timescale,
        duration: duration / timescale,
        isKeyframe: !syncSamples || syncSamples.has(sampleIndex + 1)
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
 * @param {object} [options]
 * @param {'before'|'after'} [options.boundary='before'] - 'before': segments
 *   stay under the target; 'after': each ends at the first keyframe at or
 *   after it (ffmpeg's hls_time)
 * @returns {Array} Array of segment definitions
 */
export function buildSegments(videoSamples, targetDuration = 4, options = {}) {
  const after = options.boundary === 'after';
  const segments = [];
  if (videoSamples.length === 0) return segments;

  // `videoSamples` are in decode order and `index` is the position in the
  // full table; slices use positions, so map keyframes to positions here.
  const keyPositions = [];
  for (let i = 0; i < videoSamples.length; i++) {
    if (videoSamples[i].isKeyframe) keyPositions.push(i);
  }
  if (keyPositions.length === 0) return segments;

  // End of presentation: with B-frames the last sample in decode order is
  // not the last one shown, so take the max over all samples.
  let presentationEnd = -Infinity;
  for (const s of videoSamples) presentationEnd = Math.max(presentationEnd, s.time + s.duration);

  // GOPs are merged into segments. 'before' (default): a segment takes the
  // next GOP only while it stays under `targetDuration`. 'after' (ffmpeg's
  // hls_time): a segment ends at the first keyframe at or after
  // `targetDuration` from its start (within 50 ms).
  for (let k = 0; k < keyPositions.length; k++) {
    const startPos = keyPositions[k];
    const endPos = k + 1 < keyPositions.length ? keyPositions[k + 1] : videoSamples.length;
    const startTime = videoSamples[startPos].time;
    const endTime = endPos < videoSamples.length ? videoSamples[endPos].time : presentationEnd;
    const prev = segments[segments.length - 1];

    const merge = prev && (after
      ? prev.duration < targetDuration - 0.05
      : prev.duration + (endTime - startTime) < targetDuration);
    if (merge) {
      prev.videoEnd = endPos;
      prev.endTime = endTime;
      prev.duration = endTime - prev.startTime;
    } else {
      segments.push({
        index: segments.length,
        startTime,
        endTime,
        duration: endTime - startTime,
        videoStart: startPos,
        videoEnd: endPos
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
  buildSegments(targetDuration = 4, options = {}) {
    return buildSegments(this.videoSamples, targetDuration, options);
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

