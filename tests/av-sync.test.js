/**
 * A/V Sync Regression Tests
 *
 * Verifies that clipped MP4s maintain audio/video sync regardless of
 * whether the player supports edit lists. When clipping between keyframes,
 * both tracks must cover the same time span in the mdat so that players
 * which ignore edit lists still play them in sync.
 *
 * Run: node tests/av-sync.test.js
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
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    throw new Error(`${message || 'Value mismatch'}: expected ~${expected}, got ${actual} (diff: ${diff.toFixed(4)})`);
  }
}

// ── MP4 inspection helpers ────────────────────────────────

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

function children(box, headerSize = 8) {
  return parseBoxes(box.data, headerSize, box.size);
}

function getTrackInfo(trak) {
  const trakChildren = children(trak);
  const mdia = findBox(trakChildren, 'mdia');
  if (!mdia) return null;
  const mdiaChildren = children(mdia);

  const hdlr = findBox(mdiaChildren, 'hdlr');
  let handler = '????';
  if (hdlr && hdlr.data.byteLength >= 20) {
    handler = String.fromCharCode(hdlr.data[16], hdlr.data[17], hdlr.data[18], hdlr.data[19]);
  }

  const mdhd = findBox(mdiaChildren, 'mdhd');
  let timescale = 90000;
  let mediaDuration = 0;
  if (mdhd) {
    const v = new DataView(mdhd.data.buffer, mdhd.data.byteOffset, mdhd.data.byteLength);
    const version = mdhd.data[8];
    timescale = version === 0 ? v.getUint32(20) : v.getUint32(28);
    mediaDuration = version === 0 ? v.getUint32(24) : Number(v.getBigUint64(32));
  }

  const edts = findBox(trakChildren, 'edts');
  let elst = null;
  if (edts) {
    const elstBox = findBox(children(edts), 'elst');
    if (elstBox && elstBox.data.byteLength >= 28) {
      const v = new DataView(elstBox.data.buffer, elstBox.data.byteOffset, elstBox.data.byteLength);
      const version = elstBox.data[8];
      elst = version === 0
        ? { segmentDuration: v.getUint32(16), mediaTime: v.getInt32(20) }
        : { segmentDuration: Number(v.getBigInt64(16)), mediaTime: Number(v.getBigInt64(24)) };
    }
  }

  return { handler, timescale, mediaDuration, elst };
}

function inspectTracks(mp4Data) {
  const moov = findBox(parseBoxes(mp4Data), 'moov');
  const traks = children(moov).filter(b => b.type === 'trak');
  const result = {};
  for (const trak of traks) {
    const info = getTrackInfo(trak);
    if (!info) continue;
    if (info.handler === 'vide') result.video = info;
    if (info.handler === 'soun') result.audio = info;
  }
  return result;
}

// ── tolerance ─────────────────────────────────────────────
// AAC frames are 1024 samples. At 48kHz that's ~21ms, at 44.1kHz ~23ms.
// Two AAC frames of tolerance is acceptable for A/V sync — near stream
// boundaries, audio and video may not end on exactly the same frame.
const AAC_FRAME_TOLERANCE_SEC = 0.05;

// ══════════════════════════════════════════════════════════
//  fMP4 tests
// ══════════════════════════════════════════════════════════

const fmp4Source = new Uint8Array(readFileSync('./tests/fmp4-samples/combined.mp4'));

const tests = [

  test('fMP4: A/V media durations match when clipping between keyframes', async () => {
    const full = convertFmp4ToMp4(fmp4Source);
    const parser = new MP4Parser(full);
    const samples = parser.getVideoSamples();
    const nonKey = samples.find(s => !s.isKeyframe && s.time > 2);
    assert(nonKey, 'Need a non-keyframe sample');

    const startTime = nonKey.time;
    const endTime = Math.min(parser.duration, startTime + 3);
    const clipped = convertFmp4ToMp4(fmp4Source, { startTime, endTime });

    const { video, audio } = inspectTracks(clipped);
    assert(video, 'Output must have video track');
    assert(audio, 'Output must have audio track');

    const videoDur = video.mediaDuration / video.timescale;
    const audioDur = audio.mediaDuration / audio.timescale;
    const diff = Math.abs(videoDur - audioDur);

    console.log(`   Video mdat: ${videoDur.toFixed(3)}s, Audio mdat: ${audioDur.toFixed(3)}s, diff: ${diff.toFixed(3)}s`);
    assertApprox(videoDur, audioDur, AAC_FRAME_TOLERANCE_SEC,
      'Video and audio media durations must match (within 1 AAC frame)');
  }),

  test('fMP4: both tracks get matching edit list preroll', async () => {
    const full = convertFmp4ToMp4(fmp4Source);
    const parser = new MP4Parser(full);
    const samples = parser.getVideoSamples();
    const nonKey = samples.find(s => !s.isKeyframe && s.time > 2);

    const startTime = nonKey.time;
    const endTime = Math.min(parser.duration, startTime + 3);
    const clipped = convertFmp4ToMp4(fmp4Source, { startTime, endTime });

    const { video, audio } = inspectTracks(clipped);
    assert(video.elst, 'Video must have edit list');
    assert(audio.elst, 'Audio must have edit list when video has preroll');

    const videoPreroll = video.elst.mediaTime / video.timescale;
    const audioPreroll = audio.elst.mediaTime / audio.timescale;

    console.log(`   Video preroll: ${videoPreroll.toFixed(3)}s, Audio preroll: ${audioPreroll.toFixed(3)}s`);
    assertApprox(videoPreroll, audioPreroll, AAC_FRAME_TOLERANCE_SEC,
      'Video and audio edit list preroll must match');
    assert(videoPreroll > 0, 'Preroll must be > 0 for non-keyframe clip');
  }),

  test('fMP4: no desync when clipping at keyframe', async () => {
    const full = convertFmp4ToMp4(fmp4Source);
    const parser = new MP4Parser(full);
    const keyframes = parser.getVideoSamples().filter(s => s.isKeyframe);
    assert(keyframes.length > 0, 'Need keyframes');

    const startTime = keyframes[0].time;
    const endTime = Math.min(parser.duration, startTime + 3);
    const clipped = convertFmp4ToMp4(fmp4Source, { startTime, endTime });

    const { video, audio } = inspectTracks(clipped);
    const videoDur = video.mediaDuration / video.timescale;
    const audioDur = audio.mediaDuration / audio.timescale;

    console.log(`   Video mdat: ${videoDur.toFixed(3)}s, Audio mdat: ${audioDur.toFixed(3)}s`);
    assertApprox(videoDur, audioDur, AAC_FRAME_TOLERANCE_SEC,
      'Keyframe-aligned clip must also have matching durations');
  }),

  test('fMP4: full conversion (no clip) has no desync', async () => {
    const mp4 = convertFmp4ToMp4(fmp4Source);
    const { video, audio } = inspectTracks(mp4);
    const videoDur = video.mediaDuration / video.timescale;
    const audioDur = audio.mediaDuration / audio.timescale;

    console.log(`   Video mdat: ${videoDur.toFixed(3)}s, Audio mdat: ${audioDur.toFixed(3)}s`);
    assertApprox(videoDur, audioDur, 0.5, 'Full conversion durations should be close');
  }),

  // ════════════════════════════════════════════════════════
  //  MPEG-TS tests (requires network)
  // ════════════════════════════════════════════════════════

  test('MPEG-TS: A/V media durations match when clipping between keyframes', async () => {
    console.log('   Downloading test stream...');
    const tsData = await toMp4.downloadHls(
      'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
      { quality: 'highest', maxSegments: 10, onProgress: () => {} }
    );
    globalThis._tsData = tsData;

    const info = toMp4.analyze(tsData);
    globalThis._tsInfo = info;
    assert(info.keyframes.length >= 3, 'Need at least 3 keyframes');

    // Pick a time between keyframe 1 and keyframe 2
    const kf1 = info.keyframes[1];
    const kf2 = info.keyframes[2];
    const midTime = kf1.time + (kf2.time - kf1.time) * 0.4;
    const endTime = Math.min(info.duration, midTime + 4);

    console.log(`   Clip: ${midTime.toFixed(2)}s – ${endTime.toFixed(2)}s (keyframe at ${kf1.time.toFixed(2)}s)`);

    const mp4 = await toMp4(tsData, { startTime: midTime, endTime, onProgress: () => {} });
    const { video, audio } = inspectTracks(mp4.data);
    assert(video, 'Output must have video track');
    assert(audio, 'Output must have audio track');

    const videoDur = video.mediaDuration / video.timescale;
    const audioDur = audio.mediaDuration / audio.timescale;
    const diff = Math.abs(videoDur - audioDur);

    console.log(`   Video mdat: ${videoDur.toFixed(3)}s, Audio mdat: ${audioDur.toFixed(3)}s, diff: ${diff.toFixed(3)}s`);
    assertApprox(videoDur, audioDur, AAC_FRAME_TOLERANCE_SEC,
      'Video and audio media durations must match (within 1 AAC frame)');
  }),

  test('MPEG-TS: both tracks get matching edit list preroll', async () => {
    const tsData = globalThis._tsData;
    const info = globalThis._tsInfo;

    const kf1 = info.keyframes[1];
    const kf2 = info.keyframes[2];
    const midTime = kf1.time + (kf2.time - kf1.time) * 0.4;
    const endTime = Math.min(info.duration, midTime + 4);

    const mp4 = await toMp4(tsData, { startTime: midTime, endTime, onProgress: () => {} });
    const { video, audio } = inspectTracks(mp4.data);

    assert(video.elst, 'Video must have edit list');
    assert(audio.elst, 'Audio must have edit list when video has preroll');

    const videoPreroll = video.elst.mediaTime / video.timescale;
    const audioPreroll = audio.elst.mediaTime / audio.timescale;

    console.log(`   Video preroll: ${videoPreroll.toFixed(3)}s, Audio preroll: ${audioPreroll.toFixed(3)}s`);
    assertApprox(videoPreroll, audioPreroll, AAC_FRAME_TOLERANCE_SEC,
      'Video and audio edit list preroll must match');
    assert(videoPreroll > 0, 'Preroll must be > 0 for non-keyframe clip');
  }),

  test('MPEG-TS: large preroll still stays in sync', async () => {
    const tsData = globalThis._tsData;
    const info = globalThis._tsInfo;

    // Pick a point far from any keyframe for maximum preroll
    const kf = info.keyframes[info.keyframes.length - 2];
    const kfNext = info.keyframes[info.keyframes.length - 1];
    if (!kf || !kfNext) { console.log('   Not enough keyframes, skipping'); return; }

    // 80% between the two keyframes — large preroll
    const startTime = kf.time + (kfNext.time - kf.time) * 0.8;
    const endTime = Math.min(info.duration, startTime + 3);

    console.log(`   Clip: ${startTime.toFixed(2)}s – ${endTime.toFixed(2)}s (keyframe at ${kf.time.toFixed(2)}s, preroll ~${(startTime - kf.time).toFixed(2)}s)`);

    const mp4 = await toMp4(tsData, { startTime, endTime, onProgress: () => {} });
    const { video, audio } = inspectTracks(mp4.data);

    const videoDur = video.mediaDuration / video.timescale;
    const audioDur = audio.mediaDuration / audio.timescale;
    const diff = Math.abs(videoDur - audioDur);

    console.log(`   Video mdat: ${videoDur.toFixed(3)}s, Audio mdat: ${audioDur.toFixed(3)}s, diff: ${diff.toFixed(3)}s`);
    assertApprox(videoDur, audioDur, AAC_FRAME_TOLERANCE_SEC,
      'Large preroll must still keep A/V in sync');
  }),

];

// ── runner ────────────────────────────────────────────────

async function runTests(tests) {
  console.log('\n' + '='.repeat(60));
  console.log('   A/V Sync Regression Tests');
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
