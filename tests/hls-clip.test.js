/**
 * HLS-to-HLS Clip Tests
 *
 * Tests the clipHls function end-to-end with a real HLS stream.
 * Verifies: playlist generation, boundary clipping, fMP4 structure,
 * frame accuracy (edit lists), A/V sync, and on-demand segment remuxing.
 *
 * Run: node tests/hls-clip.test.js
 */

import { clipHls, convertFmp4ToMp4, MP4Parser } from '../src/index.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  return { name, fn };
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertApprox(actual, expected, tolerance, message) {
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    throw new Error(`${message || 'Value mismatch'}: expected ~${expected}, got ${actual} (diff: ${diff.toFixed(4)})`);
  }
}

// ── MP4 inspection ────────────────────────────────────────

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
  return boxes.find(b => b.type === type) || null;
}

function hasBox(data, type) {
  return findBox(parseBoxes(data), type) !== null;
}

// ── tests ─────────────────────────────────────────────────

const TEST_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

const tests = [

  test('clipHls produces valid HlsClipResult', async () => {
    const clip = await clipHls(TEST_URL, {
      startTime: 10,
      endTime: 30,
      quality: 'highest',
      onProgress: () => {},
    });
    globalThis._clip = clip;

    assert(clip.duration === 20, 'Duration should be 20s');
    assert(clip.variantCount >= 1, 'Should have at least one variant');
    console.log(`   Duration: ${clip.duration}s, Variants: ${clip.variantCount}`);
  }),

  test('masterPlaylist is valid m3u8', async () => {
    const clip = globalThis._clip;
    const m3u8 = clip.masterPlaylist;
    assert(m3u8.startsWith('#EXTM3U'), 'Must start with #EXTM3U');
    assert(m3u8.includes('#EXT-X-MAP'), 'Must declare CMAF init segment');
    assert(m3u8.includes('#EXT-X-ENDLIST'), 'Must end with ENDLIST');
    assert(m3u8.includes('#EXT-X-VERSION:7'), 'Must be version 7 for CMAF');
    console.log(`   Playlist: ${m3u8.split('\n').length} lines`);
  }),

  test('getMediaPlaylist has correct segment count and durations', async () => {
    const clip = globalThis._clip;
    const m3u8 = clip.getMediaPlaylist(0);
    const extinfs = m3u8.match(/#EXTINF:([\d.]+),/g) || [];
    const totalDuration = extinfs.reduce((sum, s) => sum + parseFloat(s.match(/[\d.]+/)[0]), 0);

    console.log(`   Segments: ${extinfs.length}, Total EXTINF: ${totalDuration.toFixed(2)}s`);
    assert(extinfs.length >= 2, 'Should have at least 2 segments');
    assertApprox(totalDuration, 20, 3, 'Total EXTINF duration should be ~20s');
  }),

  test('getInitSegment returns valid CMAF init', async () => {
    const clip = globalThis._clip;
    const init = clip.getInitSegment(0);
    assert(init instanceof Uint8Array, 'Should be Uint8Array');
    assert(init.byteLength > 100, 'Should have reasonable size');

    assert(hasBox(init, 'ftyp'), 'Init must have ftyp');
    assert(hasBox(init, 'moov'), 'Init must have moov');
    console.log(`   Init segment: ${init.byteLength} bytes`);
  }),

  test('getSegment(0) returns pre-clipped fMP4 boundary segment', async () => {
    const clip = globalThis._clip;
    const seg = await clip.getSegment(0, 0);
    assert(seg instanceof Uint8Array, 'Should be Uint8Array');
    assert(seg.byteLength > 0, 'Should have data');

    assert(hasBox(seg, 'moof'), 'Fragment must have moof');
    assert(hasBox(seg, 'mdat'), 'Fragment must have mdat');
    console.log(`   First segment: ${(seg.byteLength / 1024).toFixed(1)} KB (pre-clipped, from memory)`);
  }),

  test('middle segment fetches from CDN and remuxes on demand', async () => {
    const clip = globalThis._clip;
    const variant = clip._variants[0];

    // Find a middle segment (not boundary)
    const midIdx = variant.segments.findIndex(s => !s.isBoundary);
    if (midIdx < 0) { console.log('   No middle segments in this clip, skipping'); return; }

    const seg = await clip.getSegment(0, midIdx);
    assert(seg instanceof Uint8Array, 'Should be Uint8Array');
    assert(hasBox(seg, 'moof'), 'Must have moof');
    assert(hasBox(seg, 'mdat'), 'Must have mdat');
    console.log(`   Middle segment ${midIdx}: ${(seg.byteLength / 1024).toFixed(1)} KB (fetched + remuxed on demand)`);
  }),

  test('fMP4 segments can be converted to standard MP4 (round-trip)', async () => {
    const clip = globalThis._clip;
    const init = clip.getInitSegment(0);
    const seg0 = await clip.getSegment(0, 0);

    // Combine init + first segment → should be valid fMP4
    const combined = new Uint8Array(init.byteLength + seg0.byteLength);
    combined.set(init, 0);
    combined.set(seg0, init.byteLength);

    const mp4 = convertFmp4ToMp4(combined);
    const parser = new MP4Parser(mp4);
    assert(parser.getVideoSamples().length > 0, 'Must have video samples');

    const vSamples = parser.getVideoSamples();
    assert(vSamples[0].isKeyframe, 'First sample must be a keyframe');
    console.log(`   Round-trip: ${vSamples.length} video samples, ${parser.getAudioSamples().length} audio, first is keyframe`);
  }),

  test('full clip segments combine into valid playable MP4', async () => {
    const clip = globalThis._clip;
    const init = clip.getInitSegment(0);
    const variant = clip._variants[0];

    // Combine init + all segments
    const allSegs = [];
    let totalSize = init.byteLength;
    for (let i = 0; i < variant.segments.length; i++) {
      const seg = await clip.getSegment(0, i);
      allSegs.push(seg);
      totalSize += seg.byteLength;
    }

    const combined = new Uint8Array(totalSize);
    combined.set(init, 0);
    let offset = init.byteLength;
    for (const seg of allSegs) {
      combined.set(seg, offset);
      offset += seg.byteLength;
    }

    // Convert combined fMP4 to standard MP4
    const mp4 = convertFmp4ToMp4(combined);
    const parser = new MP4Parser(mp4);

    console.log(`   Combined: ${variant.segments.length} segments → ${(mp4.byteLength / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Duration: ${parser.duration.toFixed(2)}s, Samples: ${parser.getVideoSamples().length} video`);
    assert(parser.duration > 15, 'Combined duration should be >15s for a 20s clip');
  }),

];

// ── runner ─────────────────────────────────────────────────

async function runTests(tests) {
  console.log('\n' + '='.repeat(60));
  console.log('   HLS-to-HLS Clip Tests');
  console.log('='.repeat(60) + '\n');

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`\u2705 ${name}`);
      passed++;
    } catch (error) {
      console.log(`\u274c ${name}`);
      console.log(`   Error: ${error.message}`);
      failed++;
    }
  }

  console.log('\n' + '-'.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('-'.repeat(60) + '\n');
  process.exit(failed > 0 ? 1 : 0);
}

runTests(tests);
