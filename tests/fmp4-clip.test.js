/**
 * fMP4 clipping tests (sample-level timing + edit-list preroll).
 *
 * Run: node tests/fmp4-clip.test.js
 */

import { readFileSync } from 'node:fs';
import { convertFmp4ToMp4, MP4Parser, toMp4 } from '../src/index.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    return { name, fn };
}

function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
}

function assertApprox(actual, expected, tolerance, message) {
    if (Math.abs(actual - expected) > tolerance) {
        throw new Error(message || `Expected ~${expected}, got ${actual}`);
    }
}

function parseBoxes(data, offset = 0, end = data.byteLength) {
    const boxes = [];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    while (offset + 8 <= end) {
        const size = view.getUint32(offset);
        if (size < 8) break;
        const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
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

function getDurationSeconds(mp4Data) {
    const moov = findBox(parseBoxes(mp4Data), 'moov');
    if (!moov) return 0;
    const mvhd = findBox(parseChildBoxes(moov), 'mvhd');
    if (!mvhd) return 0;
    const view = new DataView(mvhd.data.buffer, mvhd.data.byteOffset, mvhd.data.byteLength);
    const version = mvhd.data[8];
    const timescale = version === 0 ? view.getUint32(20) : view.getUint32(28);
    const duration = version === 0 ? view.getUint32(24) : Number(view.getBigUint64(32));
    return timescale > 0 ? duration / timescale : 0;
}

function getVideoEditListMediaTime(mp4Data) {
    const moov = findBox(parseBoxes(mp4Data), 'moov');
    if (!moov) return null;
    const traks = parseChildBoxes(moov).filter((box) => box.type === 'trak');

    for (const trak of traks) {
        const trakChildren = parseChildBoxes(trak);
        const mdia = findBox(trakChildren, 'mdia');
        if (!mdia) continue;
        const hdlr = findBox(parseChildBoxes(mdia), 'hdlr');
        if (!hdlr || hdlr.data.byteLength < 20) continue;

        const handler = String.fromCharCode(hdlr.data[16], hdlr.data[17], hdlr.data[18], hdlr.data[19]);
        if (handler !== 'vide') continue;

        const edts = findBox(trakChildren, 'edts');
        if (!edts) return null;
        const elst = findBox(parseChildBoxes(edts), 'elst');
        if (!elst || elst.data.byteLength < 28) return null;

        const view = new DataView(elst.data.buffer, elst.data.byteOffset, elst.data.byteLength);
        const version = elst.data[8];
        const entryCount = view.getUint32(12);
        if (entryCount < 1) return null;
        if (version === 0) return view.getInt32(20);
        return Number(view.getBigInt64(24));
    }

    return null;
}

async function runTests(tests) {
    console.log('\n' + '═'.repeat(60));
    console.log('   fMP4 Clip Tests');
    console.log('═'.repeat(60) + '\n');

    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`✅ ${name}`);
            passed++;
        } catch (error) {
            console.log(`❌ ${name}`);
            console.log(`   Error: ${error.message}`);
            failed++;
        }
    }

    console.log('\n' + '─'.repeat(60));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('─'.repeat(60) + '\n');
    process.exit(failed > 0 ? 1 : 0);
}

const sourceData = new Uint8Array(readFileSync('./tests/fmp4-samples/combined.mp4'));

const tests = [
    test('convertFmp4ToMp4 preserves full conversion', async () => {
        const output = convertFmp4ToMp4(sourceData);
        const topLevel = parseBoxes(output);
        assert(findBox(topLevel, 'ftyp'), 'Output should have ftyp');
        assert(findBox(topLevel, 'moov'), 'Output should have moov');
        assert(findBox(topLevel, 'mdat'), 'Output should have mdat');
        assert(!findBox(topLevel, 'moof'), 'Output should not contain moof');
        assert(getDurationSeconds(output) > 1, 'Output should have duration');
    }),

    test('clip by start/end produces expected duration', async () => {
        const startTime = 5.37;
        const endTime = 8.21;
        const output = convertFmp4ToMp4(sourceData, { startTime, endTime });
        const duration = getDurationSeconds(output);
        assertApprox(duration, endTime - startTime, 0.35, 'Duration should match requested clip span');

        const topLevel = parseBoxes(output);
        assert(!findBox(topLevel, 'moof'), 'Clipped output should be standard MP4');
    }),

    test('non-keyframe clip uses edit-list media_time preroll', async () => {
        const full = convertFmp4ToMp4(sourceData);
        const parser = new MP4Parser(full);
        const samples = parser.getVideoSamples();
        const nonKeySample = samples.find((sample) => !sample.isKeyframe && sample.time > 2);
        assert(nonKeySample, 'Need a non-keyframe sample for this test');

        const startTime = nonKeySample.time;
        const endTime = Math.min(parser.duration, startTime + 2.2);
        const clipped = convertFmp4ToMp4(sourceData, { startTime, endTime });
        const mediaTime = getVideoEditListMediaTime(clipped);
        assert(mediaTime !== null, 'Video track should have an edit list');
        assert(mediaTime > 0, 'Edit list media_time should be > 0 for non-keyframe clip start');
    }),

    test('toMp4.fromFmp4 passes clip options through', async () => {
        const startTime = 1.5;
        const endTime = 3.9;
        const result = toMp4.fromFmp4(sourceData, { startTime, endTime });
        const duration = getDurationSeconds(result.data);
        assertApprox(duration, endTime - startTime, 0.35, 'fromFmp4 clip duration should match requested span');
    }),
];

runTests(tests);
