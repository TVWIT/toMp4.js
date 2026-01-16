/**
 * Real fMP4 Stitch Test
 * 
 * Tests stitching actual fMP4 segments captured from RTMP stream
 * Uses DASH output with separate init segments and video/audio tracks
 * 
 * Run: node tests/fmp4-real.test.js
 */

import { stitchFmp4, toMp4, MP4Parser } from '../src/index.js';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const SAMPLES_DIR = './tests/fmp4-samples';

// Test state
let passed = 0;
let failed = 0;

function test(name, fn) {
    return { name, fn };
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message || 'Assertion failed');
    }
}

function assertApprox(actual, expected, tolerance, message) {
    if (Math.abs(actual - expected) > tolerance) {
        throw new Error(message || `Expected ~${expected}, got ${actual}`);
    }
}

async function runTests(tests) {
    console.log('\n' + '═'.repeat(60));
    console.log('   Real fMP4 Stitch Tests (RTMP Stream)');
    console.log('═'.repeat(60) + '\n');

    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`✅ ${name}`);
            passed++;
        } catch (err) {
            console.log(`❌ ${name}`);
            console.log(`   Error: ${err.message}`);
            if (err.stack) {
                const stackLine = err.stack.split('\n').find(line => line.includes('fmp4'));
                if (stackLine) console.log(`   at: ${stackLine.trim()}`);
            }
            failed++;
        }
    }

    console.log('\n' + '─'.repeat(60));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('─'.repeat(60) + '\n');

    process.exit(failed > 0 ? 1 : 0);
}

// MP4 box parsing utilities
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

function analyzeMp4(data) {
    const boxes = parseBoxes(data);
    const result = {
        hasFtyp: false,
        hasMoov: false,
        hasMdat: false,
        hasMoof: false,
        hasMvex: false,
        hasStylep: false,
        trackCount: 0,
        ftypBrand: '',
        moovDuration: 0,
        mdatSize: 0,
        boxTypes: []
    };

    for (const box of boxes) {
        result.boxTypes.push(box.type);

        if (box.type === 'ftyp') {
            result.hasFtyp = true;
            result.ftypBrand = String.fromCharCode(box.data[8], box.data[9], box.data[10], box.data[11]);
        }
        if (box.type === 'styp') {
            result.hasStylep = true;
        }
        if (box.type === 'moov') {
            result.hasMoov = true;
            const moovChildren = parseChildBoxes(box);
            for (const child of moovChildren) {
                if (child.type === 'trak') result.trackCount++;
                if (child.type === 'mvex') result.hasMvex = true;
                if (child.type === 'mvhd') {
                    const view = new DataView(child.data.buffer, child.data.byteOffset, child.data.byteLength);
                    const version = child.data[8];
                    const timescale = version === 0 ? view.getUint32(20) : view.getUint32(28);
                    const duration = version === 0 ? view.getUint32(24) : Number(view.getBigUint64(32));
                    result.moovDuration = duration / timescale;
                }
            }
        }
        if (box.type === 'mdat') {
            result.hasMdat = true;
            result.mdatSize += box.size - 8;
        }
        if (box.type === 'moof') {
            result.hasMoof = true;
        }
    }

    return result;
}

// Check if samples exist
function samplesExist() {
    if (!existsSync(SAMPLES_DIR)) return false;
    const files = readdirSync(SAMPLES_DIR);
    return files.some(f => f.startsWith('init_')) && files.some(f => f.startsWith('segment_'));
}

// ============================================================================
// Tests
// ============================================================================

const tests = [
    test('Check fMP4 samples exist', async () => {
        if (!samplesExist()) {
            throw new Error('fMP4 samples not found. Run ffmpeg capture first.');
        }

        const files = readdirSync(SAMPLES_DIR).filter(f => f.endsWith('.m4s'));
        console.log(`   Found ${files.length} .m4s files`);
    }),

    test('Analyze init segments structure', async () => {
        const init0 = readFileSync(join(SAMPLES_DIR, 'init_0.m4s'));
        const init1 = readFileSync(join(SAMPLES_DIR, 'init_1.m4s'));

        const analysis0 = analyzeMp4(init0);
        const analysis1 = analyzeMp4(init1);

        console.log(`   init_0.m4s: ${init0.length} bytes, boxes: ${analysis0.boxTypes.join(', ')}`);
        console.log(`   init_1.m4s: ${init1.length} bytes, boxes: ${analysis1.boxTypes.join(', ')}`);

        // Init segments should have ftyp and moov (with mvex for fMP4)
        assert(analysis0.hasFtyp || analysis0.boxTypes.includes('ftyp'), 'init_0 should have init data');
        assert(analysis0.hasMoov || analysis0.boxTypes.includes('moov'), 'init_0 should have moov');
    }),

    test('Analyze media segments structure', async () => {
        const seg0_1 = readFileSync(join(SAMPLES_DIR, 'segment_0_1.m4s'));
        const seg1_1 = readFileSync(join(SAMPLES_DIR, 'segment_1_1.m4s'));

        const analysis0 = analyzeMp4(seg0_1);
        const analysis1 = analyzeMp4(seg1_1);

        console.log(`   segment_0_1: ${(seg0_1.length / 1024).toFixed(0)}KB, boxes: ${analysis0.boxTypes.join(', ')}`);
        console.log(`   segment_1_1: ${(seg1_1.length / 1024).toFixed(0)}KB, boxes: ${analysis1.boxTypes.join(', ')}`);

        // Media segments should have styp (segment type) or moof/mdat
        assert(analysis0.hasMoof || analysis0.hasStylep, 'Video segment should have moof or styp');
        assert(analysis1.hasMoof || analysis1.hasStylep, 'Audio segment should have moof or styp');
    }),

    test('Stitch video segments with init', async () => {
        // Read init and video segments
        const init = readFileSync(join(SAMPLES_DIR, 'init_0.m4s'));
        const segments = [];

        for (let i = 1; i <= 4; i++) {
            const path = join(SAMPLES_DIR, `segment_0_${i}.m4s`);
            if (existsSync(path)) {
                segments.push(readFileSync(path));
            }
        }

        console.log(`   Init: ${init.length} bytes`);
        console.log(`   Segments: ${segments.length} (${segments.map(s => (s.length / 1024).toFixed(0) + 'KB').join(', ')})`);

        // Combine init + segments for stitching
        const combinedSegments = segments.map((seg, i) => {
            if (i === 0) {
                // First segment gets init prepended
                const combined = new Uint8Array(init.length + seg.length);
                combined.set(init, 0);
                combined.set(seg, init.length);
                return combined;
            }
            return seg;
        });

        // Try stitching with separate init
        const result = stitchFmp4(segments, { init });

        console.log(`   Output: ${(result.length / 1024).toFixed(0)} KB`);

        const analysis = analyzeMp4(result);
        console.log(`   Boxes: ${analysis.boxTypes.join(', ')}`);
        console.log(`   Duration: ${analysis.moovDuration.toFixed(2)}s`);

        assert(analysis.hasFtyp, 'Output should have ftyp');
        assert(analysis.hasMoov, 'Output should have moov');
        assert(analysis.hasMdat, 'Output should have mdat');
        assert(!analysis.hasMoof, 'Output should NOT have moof (standard MP4)');

        // Save output
        writeFileSync('./tests/output/stitched-video.mp4', result);
        console.log(`   Saved: tests/output/stitched-video.mp4`);
    }),

    test('Stitch audio segments with init', async () => {
        // Read init and audio segments
        const init = readFileSync(join(SAMPLES_DIR, 'init_1.m4s'));
        const segments = [];

        for (let i = 1; i <= 8; i++) {
            const path = join(SAMPLES_DIR, `segment_1_${i}.m4s`);
            if (existsSync(path)) {
                segments.push(readFileSync(path));
            }
        }

        console.log(`   Init: ${init.length} bytes`);
        console.log(`   Segments: ${segments.length}`);

        // Try stitching with separate init
        const result = stitchFmp4(segments, { init });

        console.log(`   Output: ${(result.length / 1024).toFixed(0)} KB`);

        const analysis = analyzeMp4(result);
        console.log(`   Duration: ${analysis.moovDuration.toFixed(2)}s`);

        assert(analysis.hasFtyp, 'Output should have ftyp');
        assert(analysis.hasMoov, 'Output should have moov');

        // Save output  
        writeFileSync('./tests/output/stitched-audio.m4a', result);
        console.log(`   Saved: tests/output/stitched-audio.m4a`);
    }),

    test('Verify stitched video with ffprobe', async () => {
        const { execSync } = await import('child_process');

        try {
            const result = execSync(
                'ffprobe -v quiet -print_format json -show_format -show_streams tests/output/stitched-video.mp4',
                { encoding: 'utf8' }
            );

            const info = JSON.parse(result);

            console.log(`   Codec: ${info.streams[0]?.codec_name || 'unknown'}`);
            console.log(`   Duration: ${parseFloat(info.format?.duration || 0).toFixed(2)}s`);
            console.log(`   Size: ${(parseInt(info.format?.size || 0) / 1024).toFixed(0)} KB`);
            console.log(`   Probe score: ${info.format?.probe_score || 0}`);

            assert(info.format?.probe_score >= 100, 'Probe score should be 100 (valid MP4)');
            assert(parseFloat(info.format?.duration || 0) > 0, 'Duration should be positive');
        } catch (err) {
            if (err.message?.includes('not found') || err.message?.includes('ENOENT')) {
                console.log('   ffprobe not available, skipping...');
            } else {
                throw err;
            }
        }
    }),

    test('Verify stitched audio with ffprobe', async () => {
        const { execSync } = await import('child_process');

        try {
            const result = execSync(
                'ffprobe -v quiet -print_format json -show_format -show_streams tests/output/stitched-audio.m4a',
                { encoding: 'utf8' }
            );

            const info = JSON.parse(result);

            console.log(`   Codec: ${info.streams[0]?.codec_name || 'unknown'}`);
            console.log(`   Sample rate: ${info.streams[0]?.sample_rate || 'unknown'} Hz`);
            console.log(`   Channels: ${info.streams[0]?.channels || 'unknown'}`);
            console.log(`   Duration: ${parseFloat(info.format?.duration || 0).toFixed(2)}s`);
            console.log(`   Probe score: ${info.format?.probe_score || 0}`);

            assert(info.format?.probe_score >= 100, 'Probe score should be 100 (valid M4A)');
        } catch (err) {
            if (err.message?.includes('not found') || err.message?.includes('ENOENT')) {
                console.log('   ffprobe not available, skipping...');
            } else {
                throw err;
            }
        }
    }),
];

// ============================================================================
// Run Tests
// ============================================================================

if (samplesExist()) {
    runTests(tests);
} else {
    console.log('');
    console.log('═'.repeat(60));
    console.log('   fMP4 samples not found!');
    console.log('═'.repeat(60));
    console.log('');
    console.log('To generate samples, run:');
    console.log('');
    console.log('  ffmpeg -y -i <YOUR_INPUT_SOURCE> \\');
    console.log('    -t 30 -c:v libx264 -preset ultrafast -c:a aac \\');
    console.log('    -f dash -seg_duration 4 \\');
    console.log("    -init_seg_name 'init_$RepresentationID$.m4s' \\");
    console.log("    -media_seg_name 'segment_$RepresentationID$_$Number$.m4s' \\");
    console.log('    tests/fmp4-samples/manifest.mpd');
    console.log('');
    console.log('Where <YOUR_INPUT_SOURCE> can be:');
    console.log('  - A local file: /path/to/video.mp4');
    console.log('  - An RTMP stream: rtmp://your-server/app/stream');
    console.log('  - An HLS URL: https://example.com/stream.m3u8');
    console.log('');
    process.exit(1);
}
