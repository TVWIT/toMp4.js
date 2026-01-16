/**
 * fMP4 to Standard MP4 Converter
 * 
 * Converts a fragmented MP4 file to a standard MP4 container
 * by extracting samples from fragments and rebuilding the moov box.
 * 
 * @module fmp4/converter
 */

import {
    parseBoxes, findBox, parseChildBoxes, createBox,
    parseTfhd, parseTrun
} from './utils.js';

// ============================================
// Moov Rebuilding Functions
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
// Main Converter Function
// ============================================

/**
 * Convert fragmented MP4 to standard MP4
 * @param {Uint8Array} fmp4Data - fMP4 data
 * @returns {Uint8Array} Standard MP4 data
 */
export function convertFmp4ToMp4(fmp4Data) {
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
                        const tfhdInfo = parseTfhd(tfhd.data);
                        const { samples, dataOffset } = parseTrun(trun.data, tfhdInfo);
                        if (!tracks.has(tfhdInfo.trackId)) tracks.set(tfhdInfo.trackId, { samples: [], chunkOffsets: [] });
                        const track = tracks.get(tfhdInfo.trackId);
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

export default convertFmp4ToMp4;
