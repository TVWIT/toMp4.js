/**
 * Debug edts/elst box structure
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
const output = readFileSync('./tests/output/stitched-video.mp4');
const boxes = parseBoxes(output);
const moov = findBox(boxes, 'moov');
const moovChildren = parseChildBoxes(moov);
const trak = findBox(moovChildren, 'trak');
const trakChildren = parseChildBoxes(trak);

console.log('trak children:', trakChildren.map(b => b.type).join(', '));

const edts = findBox(trakChildren, 'edts');
if (edts) {
    console.log('\nedts box:', edts.size, 'bytes');
    console.log('edts raw:', Array.from(edts.data).map(x => x.toString(16).padStart(2, '0')).join(' '));

    const elst = findBox(parseChildBoxes(edts), 'elst');
    if (elst) {
        console.log('\nelst box:', elst.size, 'bytes');
        console.log('elst raw:', Array.from(elst.data).map(x => x.toString(16).padStart(2, '0')).join(' '));

        const view = new DataView(elst.data.buffer, elst.data.byteOffset, elst.data.byteLength);
        const version = elst.data[8];
        const flags = (elst.data[9] << 16) | (elst.data[10] << 8) | elst.data[11];
        const entryCount = view.getUint32(12);

        console.log(`\nelst: version=${version}, flags=${flags}, entries=${entryCount}`);

        let offset = 16;
        for (let i = 0; i < entryCount; i++) {
            if (version === 0) {
                const segmentDuration = view.getUint32(offset);
                const mediaTime = view.getInt32(offset + 4);
                const mediaRateInteger = view.getInt16(offset + 8);
                const mediaRateFraction = view.getInt16(offset + 10);
                console.log(`  entry ${i}: segmentDuration=${segmentDuration}, mediaTime=${mediaTime}, rate=${mediaRateInteger}.${mediaRateFraction}`);
                offset += 12;
            } else {
                const segmentDuration = Number(view.getBigUint64(offset));
                const mediaTime = Number(view.getBigInt64(offset + 8));
                const mediaRateInteger = view.getInt16(offset + 16);
                const mediaRateFraction = view.getInt16(offset + 18);
                console.log(`  entry ${i}: segmentDuration=${segmentDuration}, mediaTime=${mediaTime}, rate=${mediaRateInteger}.${mediaRateFraction}`);
                offset += 20;
            }
        }
    }
} else {
    console.log('No edts box found');
}

// Also check if there's an issue with the moov box ordering
console.log('\n=== MOOV BOX ORDER ===');
for (const child of moovChildren) {
    console.log(`${child.type}: offset=${child.offset}, size=${child.size}`);
}
