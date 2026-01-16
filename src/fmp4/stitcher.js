/**
 * Fragmented MP4 Segment Stitching
 * Combine multiple fMP4 segments into a single standard MP4
 * Pure JavaScript - no dependencies
 */

// ============================================
// Box Utilities (shared with fmp4-to-mp4.js)
// ============================================

function parseBoxes(data, offset = 0, end = data.byteLength) {
  const boxes = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  while (offset < end) {
    if (offset + 8 > end) break;
    const size = view.getUint32(offset);
    const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
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
// Fragment Parsing
// ============================================

function parseTfhd(tfhdData) {
  const view = new DataView(tfhdData.buffer, tfhdData.byteOffset, tfhdData.byteLength);
  const flags = (tfhdData[9] << 16) | (tfhdData[10] << 8) | tfhdData[11];
  const trackId = view.getUint32(12);
  let offset = 16;
  let baseDataOffset = 0, defaultSampleDuration = 0, defaultSampleSize = 0, defaultSampleFlags = 0;

  if (flags & 0x1) { baseDataOffset = Number(view.getBigUint64(offset)); offset += 8; }
  if (flags & 0x2) offset += 4; // sample description index
  if (flags & 0x8) { defaultSampleDuration = view.getUint32(offset); offset += 4; }
  if (flags & 0x10) { defaultSampleSize = view.getUint32(offset); offset += 4; }
  if (flags & 0x20) { defaultSampleFlags = view.getUint32(offset); offset += 4; }

  return { trackId, flags, baseDataOffset, defaultSampleDuration, defaultSampleSize, defaultSampleFlags };
}

function parseTfdt(tfdtData) {
  const view = new DataView(tfdtData.buffer, tfdtData.byteOffset, tfdtData.byteLength);
  const version = tfdtData[8];
  if (version === 1) {
    return Number(view.getBigUint64(12));
  }
  return view.getUint32(12);
}

function parseTrun(trunData, defaults = {}) {
  const view = new DataView(trunData.buffer, trunData.byteOffset, trunData.byteLength);
  const version = trunData[8];
  const flags = (trunData[9] << 16) | (trunData[10] << 8) | trunData[11];
  const sampleCount = view.getUint32(12);
  let offset = 16;
  let dataOffset = 0;
  let firstSampleFlags = null;

  if (flags & 0x1) { dataOffset = view.getInt32(offset); offset += 4; }
  if (flags & 0x4) { firstSampleFlags = view.getUint32(offset); offset += 4; }

  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    const sample = {
      duration: defaults.defaultSampleDuration || 0,
      size: defaults.defaultSampleSize || 0,
      flags: (i === 0 && firstSampleFlags !== null) ? firstSampleFlags : (defaults.defaultSampleFlags || 0),
      compositionTimeOffset: 0
    };
    if (flags & 0x100) { sample.duration = view.getUint32(offset); offset += 4; }
    if (flags & 0x200) { sample.size = view.getUint32(offset); offset += 4; }
    if (flags & 0x400) { sample.flags = view.getUint32(offset); offset += 4; }
    if (flags & 0x800) {
      sample.compositionTimeOffset = version === 0 ? view.getUint32(offset) : view.getInt32(offset);
      offset += 4;
    }
    samples.push(sample);
  }

  return { samples, dataOffset, flags };
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

function rebuildTkhd(tkhdBox, trackInfo, movieTimescale) {
  const data = new Uint8Array(tkhdBox.data);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = data[8];

  // Duration in tkhd must be in movie timescale (from mvhd)
  let trackDuration = 0;
  if (trackInfo && trackInfo.samples.length > 0) {
    // Sum sample durations (in media timescale)
    let mediaDuration = 0;
    for (const s of trackInfo.samples) mediaDuration += s.duration || 0;
    // Convert from media timescale to movie timescale
    if (trackInfo.timescale && movieTimescale) {
      trackDuration = Math.round(mediaDuration * movieTimescale / trackInfo.timescale);
    } else {
      trackDuration = mediaDuration; // Fallback
    }
  }

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

function rebuildMdia(mdiaBox, trackInfo, movieTimescale) {
  const mdiaChildren = parseChildBoxes(mdiaBox);
  const newParts = [];

  // First pass: extract timescale from mdhd for this track
  for (const child of mdiaChildren) {
    if (child.type === 'mdhd') {
      const view = new DataView(child.data.buffer, child.data.byteOffset, child.data.byteLength);
      const version = child.data[8];
      const timescale = version === 0 ? view.getUint32(20) : view.getUint32(28);
      if (trackInfo) trackInfo.timescale = timescale;
    }
  }

  for (const child of mdiaChildren) {
    if (child.type === 'minf') newParts.push(rebuildMinf(child, trackInfo));
    else if (child.type === 'mdhd') newParts.push(rebuildMdhd(child, trackInfo, movieTimescale));
    else newParts.push(child.data);
  }
  return createBox('mdia', ...newParts);
}

function rebuildTrak(trakBox, trackIdMap, movieTimescale) {
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

  // First rebuild mdia to get timescale
  for (const child of trakChildren) {
    if (child.type === 'mdia') {
      newParts.push(rebuildMdia(child, trackInfo, movieTimescale));
    }
  }

  // Then rebuild other boxes with proper timescale info
  const tkhdIdx = newParts.length;
  for (const child of trakChildren) {
    if (child.type === 'edts') continue; // Skip - we rebuild edts with correct duration
    else if (child.type === 'mdia') continue; // Already added
    else if (child.type === 'tkhd') newParts.push(rebuildTkhd(child, trackInfo, movieTimescale));
    else newParts.push(child.data);
  }

  // Reorder: tkhd should come first after rebuilding
  // Find tkhd in newParts and move it to front
  for (let i = tkhdIdx; i < newParts.length; i++) {
    if (newParts[i].length >= 8) {
      const type = String.fromCharCode(newParts[i][4], newParts[i][5], newParts[i][6], newParts[i][7]);
      if (type === 'tkhd') {
        const tkhd = newParts.splice(i, 1)[0];
        newParts.unshift(tkhd);
        break;
      }
    }
  }

  // Always create new edts with correct duration (don't use original which has duration=0)
  // Remove any existing edts first
  for (let i = newParts.length - 1; i >= 0; i--) {
    if (newParts[i].length >= 8) {
      const type = String.fromCharCode(newParts[i][4], newParts[i][5], newParts[i][6], newParts[i][7]);
      if (type === 'edts') {
        newParts.splice(i, 1);
      }
    }
  }

  // Create edts with proper duration
  if (trackInfo && trackInfo.samples.length > 0) {
    let mediaDuration = 0;
    for (const s of trackInfo.samples) mediaDuration += s.duration || 0;
    const movieDuration = trackInfo.timescale && movieTimescale
      ? Math.round(mediaDuration * movieTimescale / trackInfo.timescale)
      : mediaDuration;

    const elstData = new Uint8Array(20);
    const elstView = new DataView(elstData.buffer);
    elstView.setUint32(4, 1);  // entry count
    elstView.setUint32(8, movieDuration);  // segment duration
    elstView.setInt32(12, 0);   // media time (0 = start of track)
    elstView.setInt16(16, 1);   // media rate integer (1.0)
    elstView.setInt16(18, 0);   // media rate fraction
    const elst = createBox('elst', elstData);
    const edts = createBox('edts', elst);

    // Insert after tkhd
    for (let i = 0; i < newParts.length; i++) {
      if (newParts[i].length >= 8) {
        const type = String.fromCharCode(newParts[i][4], newParts[i][5], newParts[i][6], newParts[i][7]);
        if (type === 'tkhd') {
          newParts.splice(i + 1, 0, edts);
          break;
        }
      }
    }
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
      const type = String.fromCharCode(output[pos + 4], output[pos + 5], output[pos + 6], output[pos + 7]);
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

// ============================================
// Main Stitching Function
// ============================================

/**
 * Stitch multiple fMP4 segments into a single standard MP4
 * 
 * @param {(Uint8Array | ArrayBuffer)[]} segments - Array of fMP4 segment data
 *        Each segment can be self-contained (init+data) or just data (moof/mdat)
 * @param {Object} [options] - Stitch options
 * @param {Uint8Array | ArrayBuffer} [options.init] - Optional separate init segment data (ftyp/moov)
 * @returns {Uint8Array} Standard MP4 data
 * 
 * @example
 * // Self-contained segments (each has init+data)
 * const mp4 = stitchFmp4([segment1, segment2, segment3]);
 * 
 * @example
 * // Separate init + data segments
 * const mp4 = stitchFmp4(dataSegments, { init: initSegment });
 */
export function stitchFmp4(segments, options = {}) {
  if (!segments || segments.length === 0) {
    throw new Error('stitchFmp4: At least one segment is required');
  }

  // Convert all inputs to Uint8Array
  const normalizedSegments = segments.map(seg =>
    seg instanceof ArrayBuffer ? new Uint8Array(seg) : seg
  );

  let initData = options.init
    ? (options.init instanceof ArrayBuffer ? new Uint8Array(options.init) : options.init)
    : null;

  // Track data accumulated from all segments
  const tracks = new Map(); // trackId -> { samples: [], chunkOffsets: [] }
  const mdatChunks = [];
  let combinedMdatOffset = 0;

  // Init segment info
  let ftyp = null;
  let moov = null;
  let originalTrackIds = [];

  // Process init segment if provided separately
  if (initData) {
    const initBoxes = parseBoxes(initData);
    ftyp = findBox(initBoxes, 'ftyp');
    moov = findBox(initBoxes, 'moov');
    if (!ftyp || !moov) {
      throw new Error('stitchFmp4: Init segment missing ftyp or moov');
    }
    originalTrackIds = extractTrackIds(moov);
  }

  // Process each segment
  for (let segIdx = 0; segIdx < normalizedSegments.length; segIdx++) {
    const segmentData = normalizedSegments[segIdx];
    const boxes = parseBoxes(segmentData);

    // Check if segment has init data
    const segFtyp = findBox(boxes, 'ftyp');
    const segMoov = findBox(boxes, 'moov');

    // Use first segment's init if no separate init provided
    if (!ftyp && segFtyp) {
      ftyp = segFtyp;
    }
    if (!moov && segMoov) {
      moov = segMoov;
      originalTrackIds = extractTrackIds(moov);
    }

    // Process fragment boxes (moof + mdat pairs)
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];

      if (box.type === 'moof') {
        const moofChildren = parseChildBoxes(box);
        const moofStart = box.offset;

        // Find the next mdat
        let nextMdat = null;
        let nextMdatOffset = 0;
        for (let j = i + 1; j < boxes.length; j++) {
          if (boxes[j].type === 'mdat') {
            nextMdat = boxes[j];
            nextMdatOffset = boxes[j].offset;
            break;
          }
          if (boxes[j].type === 'moof') break;
        }

        // Process each traf (track fragment)
        for (const child of moofChildren) {
          if (child.type === 'traf') {
            const trafChildren = parseChildBoxes(child);
            const tfhdBox = findBox(trafChildren, 'tfhd');
            const trunBox = findBox(trafChildren, 'trun');
            const tfdtBox = findBox(trafChildren, 'tfdt');

            if (tfhdBox && trunBox) {
              const tfhd = parseTfhd(tfhdBox.data);
              const { samples, dataOffset } = parseTrun(trunBox.data, tfhd);

              if (!tracks.has(tfhd.trackId)) {
                tracks.set(tfhd.trackId, { samples: [], chunkOffsets: [] });
              }
              const track = tracks.get(tfhd.trackId);

              // Calculate chunk offset within combined mdat
              const chunkOffset = combinedMdatOffset + (moofStart + dataOffset) - (nextMdatOffset + 8);
              track.chunkOffsets.push({ offset: chunkOffset, sampleCount: samples.length });
              track.samples.push(...samples);
            }
          }
        }
      } else if (box.type === 'mdat') {
        const mdatContent = box.data.subarray(8);
        mdatChunks.push({ data: mdatContent, offset: combinedMdatOffset });
        combinedMdatOffset += mdatContent.byteLength;
      }
    }
  }

  if (!ftyp || !moov) {
    throw new Error('stitchFmp4: No init data found (missing ftyp or moov). Provide init segment or use self-contained segments.');
  }

  // Combine all mdat chunks
  const totalMdatSize = mdatChunks.reduce((sum, c) => sum + c.data.byteLength, 0);
  const combinedMdat = new Uint8Array(totalMdatSize);
  for (const chunk of mdatChunks) {
    combinedMdat.set(chunk.data, chunk.offset);
  }

  // Map track IDs
  const trackIdMap = new Map();
  const fmp4TrackIds = Array.from(tracks.keys()).sort((a, b) => a - b);
  for (let i = 0; i < fmp4TrackIds.length && i < originalTrackIds.length; i++) {
    trackIdMap.set(originalTrackIds[i], tracks.get(fmp4TrackIds[i]));
  }

  // Extract movie timescale from mvhd
  const moovChildren = parseChildBoxes(moov);
  let movieTimescale = 1000; // Default
  for (const child of moovChildren) {
    if (child.type === 'mvhd') {
      const view = new DataView(child.data.buffer, child.data.byteOffset, child.data.byteLength);
      const version = child.data[8];
      movieTimescale = version === 0 ? view.getUint32(20) : view.getUint32(28);
    }
  }

  // Rebuild moov - need to rebuild traks first to get timescales, then calculate duration
  const newMoovParts = [];
  const rebuiltTraks = [];
  for (const child of moovChildren) {
    if (child.type === 'mvex') continue; // Remove mvex (fragmented MP4 extension)
    if (child.type === 'trak') {
      rebuiltTraks.push(rebuildTrak(child, trackIdMap, movieTimescale));
    }
  }

  // Calculate max duration in movie timescale (after traks are rebuilt with timescales)
  let maxMovieDuration = 0;
  for (const [, track] of tracks) {
    if (track.samples.length > 0) {
      let mediaDuration = 0;
      for (const s of track.samples) mediaDuration += s.duration || 0;
      const movieDuration = track.timescale
        ? Math.round(mediaDuration * movieTimescale / track.timescale)
        : mediaDuration;
      maxMovieDuration = Math.max(maxMovieDuration, movieDuration);
    }
  }

  // Build moov with correct duration
  for (const child of moovChildren) {
    if (child.type === 'mvex') continue;
    if (child.type === 'trak') continue; // Added separately
    if (child.type === 'mvhd') newMoovParts.push(rebuildMvhd(child, maxMovieDuration));
    else newMoovParts.push(child.data);
  }
  // Add traks after mvhd
  newMoovParts.push(...rebuiltTraks);

  const newMoov = createBox('moov', ...newMoovParts);
  const newMdat = createBox('mdat', combinedMdat);

  // Assemble output
  const output = new Uint8Array(ftyp.size + newMoov.byteLength + newMdat.byteLength);
  output.set(ftyp.data, 0);
  output.set(newMoov, ftyp.size);
  output.set(newMdat, ftyp.size + newMoov.byteLength);

  // Fix stco offsets
  updateStcoOffsets(output, ftyp.size, newMoov.byteLength);

  return output;
}

/**
 * Extract track IDs from moov box
 */
function extractTrackIds(moovBox) {
  const trackIds = [];
  const moovChildren = parseChildBoxes(moovBox);
  for (const child of moovChildren) {
    if (child.type === 'trak') {
      const trakChildren = parseChildBoxes(child);
      for (const tc of trakChildren) {
        if (tc.type === 'tkhd') {
          const view = new DataView(tc.data.buffer, tc.data.byteOffset, tc.data.byteLength);
          trackIds.push(tc.data[8] === 0 ? view.getUint32(20) : view.getUint32(28));
        }
      }
    }
  }
  return trackIds;
}

export default stitchFmp4;
