/**
 * fMP4 Box Utilities
 * 
 * Shared utilities for parsing and creating MP4 boxes
 * Used by both converter and stitcher modules
 * 
 * @module fmp4/utils
 */

// ============================================
// Box Parsing
// ============================================

/**
 * Parse top-level or nested boxes from MP4 data
 * @param {Uint8Array} data - Data buffer
 * @param {number} offset - Start offset
 * @param {number} end - End offset
 * @returns {Array<{type: string, offset: number, size: number, data: Uint8Array}>}
 */
export function parseBoxes(data, offset = 0, end = data.byteLength) {
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

/**
 * Find a box by type in an array of boxes
 * @param {Array} boxes - Array of parsed boxes
 * @param {string} type - 4-character box type
 * @returns {object|null} Box object or null
 */
export function findBox(boxes, type) {
    for (const box of boxes) if (box.type === type) return box;
    return null;
}

/**
 * Parse child boxes within a container box
 * @param {object} box - Parent box
 * @param {number} headerSize - Header size (8 for regular, 12 for fullbox)
 * @returns {Array} Array of child boxes
 */
export function parseChildBoxes(box, headerSize = 8) {
    return parseBoxes(box.data, headerSize, box.size);
}

/**
 * Create an MP4 box with the given type and payloads
 * @param {string} type - 4-character box type
 * @param {...Uint8Array} payloads - Box content
 * @returns {Uint8Array} Complete box
 */
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

// ============================================
// Fragment Box Parsing
// ============================================

/**
 * Parse tfhd (track fragment header) box
 * Extracts track ID and default sample values
 * @param {Uint8Array} tfhdData - tfhd box data
 * @param {{defaultSampleDuration?: number, defaultSampleSize?: number, defaultSampleFlags?: number}} defaults - Defaults (e.g. from trex)
 * @returns {{trackId: number, flags: number, baseDataOffset: number, defaultSampleDuration: number, defaultSampleSize: number, defaultSampleFlags: number}}
 */
export function parseTfhd(tfhdData, defaults = {}) {
    const view = new DataView(tfhdData.buffer, tfhdData.byteOffset, tfhdData.byteLength);
    const flags = (tfhdData[9] << 16) | (tfhdData[10] << 8) | tfhdData[11];
    const trackId = view.getUint32(12);
    let offset = 16;
    let baseDataOffset = 0;
    let defaultSampleDuration = defaults.defaultSampleDuration || 0;
    let defaultSampleSize = defaults.defaultSampleSize || 0;
    let defaultSampleFlags = defaults.defaultSampleFlags || 0;

    if (flags & 0x1) {
        baseDataOffset = Number(view.getBigUint64(offset));
        offset += 8;
    }
    if (flags & 0x2) offset += 4;  // sample-description-index
    if (flags & 0x8) { defaultSampleDuration = view.getUint32(offset); offset += 4; }
    if (flags & 0x10) { defaultSampleSize = view.getUint32(offset); offset += 4; }
    if (flags & 0x20) { defaultSampleFlags = view.getUint32(offset); offset += 4; }

    return { trackId, flags, baseDataOffset, defaultSampleDuration, defaultSampleSize, defaultSampleFlags };
}

/**
 * Parse tfdt (track fragment decode time) box
 * @param {Uint8Array} tfdtData - tfdt box data
 * @returns {number} Base media decode time
 */
export function parseTfdt(tfdtData) {
    const view = new DataView(tfdtData.buffer, tfdtData.byteOffset, tfdtData.byteLength);
    const version = tfdtData[8];
    if (version === 1) {
        return Number(view.getBigUint64(12));
    }
    return view.getUint32(12);
}

/**
 * Parse trun (track run) box
 * @param {Uint8Array} trunData - trun box data
 * @param {{defaultSampleDuration?: number, defaultSampleSize?: number, defaultSampleFlags?: number}} defaults - Default values from tfhd
 * @returns {{samples: Array, dataOffset: number, flags: number}}
 */
export function parseTrun(trunData, defaults = {}) {
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
// Track ID Extraction
// ============================================

/**
 * Extract track IDs from moov box
 * @param {object} moovBox - Parsed moov box
 * @returns {number[]} Array of track IDs
 */
export function extractTrackIds(moovBox) {
    const trackIds = [];
    const moovChildren = parseChildBoxes(moovBox);
    for (const child of moovChildren) {
        if (child.type === 'trak') {
            const trakChildren = parseChildBoxes(child);
            for (const tc of trakChildren) {
                if (tc.type === 'tkhd') {
                    const view = new DataView(tc.data.buffer, tc.data.byteOffset, tc.data.byteLength);
                    const version = tc.data[8];
                    trackIds.push(version === 0 ? view.getUint32(20) : view.getUint32(28));
                }
            }
        }
    }
    return trackIds;
}

/**
 * Extract movie timescale from mvhd box
 * @param {object} moovBox - Parsed moov box
 * @returns {number} Movie timescale (default: 1000)
 */
export function getMovieTimescale(moovBox) {
    const moovChildren = parseChildBoxes(moovBox);
    for (const child of moovChildren) {
        if (child.type === 'mvhd') {
            const view = new DataView(child.data.buffer, child.data.byteOffset, child.data.byteLength);
            const version = child.data[8];
            return version === 0 ? view.getUint32(20) : view.getUint32(28);
        }
    }
    return 1000;
}
