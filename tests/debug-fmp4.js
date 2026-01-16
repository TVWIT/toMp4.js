/**
 * Debug script to analyze stitched MP4 structure
 */

import { readFileSync } from 'fs';

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

// Analyze stitched output
console.log('=== STITCHED VIDEO (stitched-video.mp4) ===');
const output = readFileSync('./tests/output/stitched-video.mp4');
const boxes = parseBoxes(output);
console.log('Top-level boxes:', boxes.map(b => `${b.type}(${b.size})`).join(', '));

const moov = findBox(boxes, 'moov');
const moovChildren = parseChildBoxes(moov);
console.log('\nmoov children:', moovChildren.map(b => b.type).join(', '));

// Analyze mvhd
const mvhd = findBox(moovChildren, 'mvhd');
if (mvhd) {
    const view = new DataView(mvhd.data.buffer, mvhd.data.byteOffset, mvhd.data.byteLength);
    const version = mvhd.data[8];
    const timescale = version === 0 ? view.getUint32(20) : view.getUint32(28);
    const duration = version === 0 ? view.getUint32(24) : Number(view.getBigUint64(32));
    console.log(`\nmvhd: version=${version}, timescale=${timescale}, duration=${duration} (${(duration / timescale).toFixed(2)}s)`);
}

// Analyze each trak
for (const child of moovChildren) {
    if (child.type === 'trak') {
        const trakChildren = parseChildBoxes(child);
        console.log('\ntrak children:', trakChildren.map(b => b.type).join(', '));

        // tkhd
        const tkhd = findBox(trakChildren, 'tkhd');
        if (tkhd) {
            const view = new DataView(tkhd.data.buffer, tkhd.data.byteOffset, tkhd.data.byteLength);
            const version = tkhd.data[8];
            const trackId = version === 0 ? view.getUint32(20) : view.getUint32(28);
            const duration = version === 0 ? view.getUint32(28) : Number(view.getBigUint64(36));
            console.log(`  tkhd: version=${version}, trackId=${trackId}, duration=${duration}`);
        }

        // mdia
        const mdia = findBox(trakChildren, 'mdia');
        if (mdia) {
            const mdiaChildren = parseChildBoxes(mdia);
            console.log('  mdia children:', mdiaChildren.map(b => b.type).join(', '));

            // mdhd
            const mdhd = findBox(mdiaChildren, 'mdhd');
            if (mdhd) {
                const view = new DataView(mdhd.data.buffer, mdhd.data.byteOffset, mdhd.data.byteLength);
                const version = mdhd.data[8];
                const timescale = version === 0 ? view.getUint32(20) : view.getUint32(28);
                const duration = version === 0 ? view.getUint32(24) : Number(view.getBigUint64(32));
                console.log(`  mdhd: version=${version}, timescale=${timescale}, duration=${duration} (${(duration / timescale).toFixed(2)}s)`);
            }

            // minf -> stbl
            const minf = findBox(mdiaChildren, 'minf');
            if (minf) {
                const minfChildren = parseChildBoxes(minf);
                const stbl = findBox(minfChildren, 'stbl');
                if (stbl) {
                    const stblChildren = parseChildBoxes(stbl);
                    console.log('  stbl children:', stblChildren.map(b => b.type).join(', '));

                    // stts
                    const stts = findBox(stblChildren, 'stts');
                    if (stts) {
                        const view = new DataView(stts.data.buffer, stts.data.byteOffset, stts.data.byteLength);
                        const entryCount = view.getUint32(12);
                        console.log(`  stts: ${entryCount} entries`);
                        let totalSamples = 0, totalDuration = 0;
                        for (let i = 0; i < Math.min(entryCount, 5); i++) {
                            const count = view.getUint32(16 + i * 8);
                            const delta = view.getUint32(20 + i * 8);
                            console.log(`    entry ${i}: count=${count}, delta=${delta}`);
                            totalSamples += count;
                            totalDuration += count * delta;
                        }
                        if (entryCount > 5) console.log(`    ... (${entryCount - 5} more entries)`);
                        console.log(`  stts total: ${totalSamples} samples, duration=${totalDuration}`);
                    }

                    // stsz
                    const stsz = findBox(stblChildren, 'stsz');
                    if (stsz) {
                        const view = new DataView(stsz.data.buffer, stsz.data.byteOffset, stsz.data.byteLength);
                        const sampleSize = view.getUint32(12);
                        const sampleCount = view.getUint32(16);
                        console.log(`  stsz: sampleSize=${sampleSize}, sampleCount=${sampleCount}`);
                    }

                    // stco
                    const stco = findBox(stblChildren, 'stco');
                    if (stco) {
                        const view = new DataView(stco.data.buffer, stco.data.byteOffset, stco.data.byteLength);
                        const entryCount = view.getUint32(12);
                        console.log(`  stco: ${entryCount} entries`);
                        for (let i = 0; i < Math.min(entryCount, 3); i++) {
                            const offset = view.getUint32(16 + i * 4);
                            console.log(`    entry ${i}: offset=${offset}`);
                        }
                    }
                }
            }
        }
    }
}

// Check mdat
const mdat = findBox(boxes, 'mdat');
if (mdat) {
    console.log(`\nmdat: offset=${mdat.offset}, size=${mdat.size} (content: ${mdat.size - 8} bytes)`);
}
