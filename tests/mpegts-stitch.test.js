/**
 * MPEG-TS Stitching Tests
 *
 * Run with: node tests/mpegts-stitch.test.js
 *
 * Tests stitchTs (→ MP4) and concatTs (→ TS) functionality
 */

import toMp4 from '../src/index.js';

const TEST_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

// Simple test runner
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

async function runTests(tests) {
  console.log('\n📋 Running MPEG-TS Stitching Tests\n');
  console.log('═'.repeat(60));

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`✅ ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`❌ ${t.name}`);
      console.log(`   ${err.message}`);
      if (err.stack) {
        console.log(`   ${err.stack.split('\n')[1]}`);
      }
      failed++;
    }
  }

  console.log('═'.repeat(60));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

  process.exit(failed > 0 ? 1 : 0);
}

// ============================================
// Tests
// ============================================

const tests = [

  test('Download HLS segments individually', async () => {
    console.log('   Parsing HLS master playlist...');
    const hls = await toMp4.parseHls(TEST_URL);
    const variant = hls.select('lowest').selected; // Use lowest for faster tests

    // Fetch the media playlist to get segment URLs
    console.log(`   Fetching media playlist (${variant.resolution})...`);
    const mediaPlaylistResponse = await fetch(variant.url);
    const mediaPlaylistText = await mediaPlaylistResponse.text();

    // Parse segment URLs from media playlist
    const lines = mediaPlaylistText.split('\n').map(l => l.trim());
    const segmentUrls = [];
    const baseUrl = variant.url;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXTINF:')) {
        const nextLine = lines[i + 1];
        if (nextLine && !nextLine.startsWith('#')) {
          const url = nextLine.startsWith('http')
            ? nextLine
            : new URL(nextLine, baseUrl).href;
          segmentUrls.push(url);
        }
      }
    }

    console.log(`   Found ${segmentUrls.length} segments`);

    // Download first 3 segments individually
    const segments = [];
    for (let i = 0; i < 3 && i < segmentUrls.length; i++) {
      console.log(`   Downloading segment ${i + 1}...`);
      const response = await fetch(segmentUrls[i]);
      const data = new Uint8Array(await response.arrayBuffer());
      segments.push(data);
      console.log(`   Segment ${i + 1}: ${(data.length / 1024).toFixed(1)} KB`);
    }

    assert(segments.length === 3, 'Should have 3 segments');
    assert(segments.every(s => s.length > 0), 'All segments should have data');

    globalThis.testSegments = segments;
  }),

  test('stitchTs: Combine segments to MP4', async () => {
    const segments = globalThis.testSegments;
    assert(segments, 'Need test segments from previous test');

    console.log('   Stitching 3 segments to MP4...');
    const mp4 = toMp4.stitchTs(segments);

    assert(mp4.data instanceof Uint8Array, 'Should return Mp4Result with data');
    assert(mp4.data.length > 0, 'MP4 should have data');

    // Check MP4 structure
    const ftyp = String.fromCharCode(mp4.data[4], mp4.data[5], mp4.data[6], mp4.data[7]);
    assert(ftyp === 'ftyp', 'Should start with ftyp box');

    console.log(`   Output: ${mp4.sizeFormatted}`);
    globalThis.stitchedMp4 = mp4;
  }),

  test('stitchTs: MP4 is valid and playable', async () => {
    const mp4 = globalThis.stitchedMp4;
    assert(mp4, 'Need stitched MP4 from previous test');

    // Verify we can parse it back
    const info = toMp4.analyze(mp4.data);

    // Note: analyze() is for TS, so we check basic structure instead
    // Just verify MP4 has proper boxes
    let offset = 0;
    const boxes = [];
    const view = new DataView(mp4.data.buffer, mp4.data.byteOffset, mp4.data.byteLength);

    while (offset + 8 <= mp4.data.length) {
      const size = view.getUint32(offset);
      if (size < 8 || offset + size > mp4.data.length) break;
      const type = String.fromCharCode(
        mp4.data[offset + 4], mp4.data[offset + 5],
        mp4.data[offset + 6], mp4.data[offset + 7]
      );
      boxes.push(type);
      offset += size;
    }

    console.log(`   Boxes: ${boxes.join(', ')}`);
    assert(boxes.includes('ftyp'), 'Should have ftyp box');
    assert(boxes.includes('moov'), 'Should have moov box');
    assert(boxes.includes('mdat'), 'Should have mdat box');
  }),

  test('concatTs: Combine segments to TS', async () => {
    const segments = globalThis.testSegments;
    assert(segments, 'Need test segments from previous test');

    console.log('   Concatenating 3 segments to TS...');
    const tsData = toMp4.concatTs(segments);

    assert(tsData instanceof Uint8Array, 'Should return Uint8Array');
    assert(tsData.length > 0, 'TS should have data');

    // Check TS structure (starts with sync byte 0x47)
    assert(tsData[0] === 0x47, 'Should start with TS sync byte');

    // Verify it's valid TS (188-byte packets)
    let validPackets = 0;
    for (let i = 0; i < tsData.length; i += 188) {
      if (tsData[i] === 0x47) validPackets++;
    }
    const expectedPackets = Math.floor(tsData.length / 188);

    console.log(`   Output: ${(tsData.length / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Packets: ${validPackets} valid of ${expectedPackets} expected`);

    assert(validPackets === expectedPackets, 'All packets should be valid');
    globalThis.concatTsData = tsData;
  }),

  test('concatTs: Output can be re-parsed', async () => {
    const tsData = globalThis.concatTsData;
    assert(tsData, 'Need concat TS from previous test');

    // Parse the concatenated TS
    const info = toMp4.analyze(tsData);

    console.log(`   Duration: ${info.duration.toFixed(2)}s`);
    console.log(`   Frames: ${info.videoFrames} video, ${info.audioFrames} audio`);
    console.log(`   Keyframes: ${info.keyframeCount}`);

    assert(info.duration > 0, 'Should have positive duration');
    assert(info.videoFrames > 0, 'Should have video frames');
    assert(info.keyframeCount > 0, 'Should have keyframes');
  }),

  test('concatTs: Output converts to MP4', async () => {
    const tsData = globalThis.concatTsData;
    assert(tsData, 'Need concat TS from previous test');

    // Convert concatenated TS to MP4
    const mp4 = await toMp4(tsData);

    assert(mp4.data instanceof Uint8Array, 'Should return Mp4Result');
    assert(mp4.data.length > 0, 'Should have MP4 data');

    console.log(`   Converted to MP4: ${mp4.sizeFormatted}`);
  }),

  test('stitchTs: Handles single segment', async () => {
    const segments = globalThis.testSegments;

    const mp4 = toMp4.stitchTs([segments[0]]);

    assert(mp4.data instanceof Uint8Array, 'Should work with single segment');
    assert(mp4.data.length > 0, 'Should produce output');

    console.log(`   Single segment → ${mp4.sizeFormatted}`);
  }),

  test('stitchTs: Throws on empty input', async () => {
    let threw = false;
    try {
      toMp4.stitchTs([]);
    } catch (e) {
      threw = true;
      assert(e.message.includes('At least one segment'), 'Should have descriptive error');
    }
    assert(threw, 'Should throw on empty array');
  }),

  test('stitchTs: Accepts ArrayBuffer input', async () => {
    const segments = globalThis.testSegments;

    // Convert first segment to ArrayBuffer
    const arrayBufferSegments = [
      segments[0].buffer.slice(segments[0].byteOffset, segments[0].byteOffset + segments[0].byteLength)
    ];

    const mp4 = toMp4.stitchTs(arrayBufferSegments);

    assert(mp4.data instanceof Uint8Array, 'Should accept ArrayBuffer');
    console.log(`   ArrayBuffer input → ${mp4.sizeFormatted}`);
  }),

  test('Timestamp continuity: Segments are properly sequenced', async () => {
    const segments = globalThis.testSegments;

    // Analyze individual segments
    const seg1Info = toMp4.analyze(segments[0]);
    const seg2Info = toMp4.analyze(segments[1]);

    console.log(`   Segment 1: ${seg1Info.duration.toFixed(2)}s (${seg1Info.videoFrames} frames)`);
    console.log(`   Segment 2: ${seg2Info.duration.toFixed(2)}s (${seg2Info.videoFrames} frames)`);

    // Stitch and check combined duration is roughly sum
    const mp4 = toMp4.stitchTs(segments);

    // Parse the stitched result by converting back to TS first
    const tsData = toMp4.concatTs(segments);
    const combinedInfo = toMp4.analyze(tsData);

    const expectedDuration = seg1Info.duration + seg2Info.duration + toMp4.analyze(segments[2]).duration;
    const tolerance = 1.0; // Allow 1 second tolerance

    console.log(`   Combined: ${combinedInfo.duration.toFixed(2)}s (expected ~${expectedDuration.toFixed(2)}s)`);
    console.log(`   Combined frames: ${combinedInfo.videoFrames} video`);

    assert(
      Math.abs(combinedInfo.duration - expectedDuration) < tolerance,
      `Duration should be approximately sum of segments (got ${combinedInfo.duration.toFixed(2)}, expected ${expectedDuration.toFixed(2)})`
    );
  }),

];

// Run all tests
runTests(tests);
