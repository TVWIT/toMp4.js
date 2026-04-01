/**
 * MP4-to-MP4 clipping tests.
 *
 * Creates a standard MP4 from the fMP4 test fixture, then clips it
 * at various time ranges and verifies frame-accurate output with A/V sync.
 *
 * Run: node tests/mp4-clip.test.js
 */

import { readFileSync } from 'node:fs';
import { convertFmp4ToMp4, clipMp4, MP4Parser, toMp4 } from '../src/index.js';

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

// ── MP4 box inspection ────────────────────────────────────

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
  let timescale = 90000, mediaDuration = 0;
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
      elst = { segmentDuration: v.getUint32(16), mediaTime: v.getInt32(20) };
    }
  }

  return { handler, timescale, mediaDuration, elst };
}

function getMvhdDuration(mp4Data) {
  const moov = findBox(parseBoxes(mp4Data), 'moov');
  const mvhd = findBox(children(moov), 'mvhd');
  if (!mvhd) return 0;
  const v = new DataView(mvhd.data.buffer, mvhd.data.byteOffset, mvhd.data.byteLength);
  const version = mvhd.data[8];
  const timescale = version === 0 ? v.getUint32(20) : v.getUint32(28);
  const duration = version === 0 ? v.getUint32(24) : Number(v.getBigUint64(32));
  return duration / timescale;
}

function inspectTracks(mp4Data) {
  const moov = findBox(parseBoxes(mp4Data), 'moov');
  const result = {};
  for (const trak of children(moov).filter(b => b.type === 'trak')) {
    const info = getTrackInfo(trak);
    if (info?.handler === 'vide') result.video = info;
    if (info?.handler === 'soun') result.audio = info;
  }
  return result;
}

const AAC_FRAME_TOLERANCE = 0.05;

// ── Create standard MP4 test source ───────────────────────

const fmp4Source = new Uint8Array(readFileSync('./tests/fmp4-samples/combined.mp4'));
const standardMp4 = convertFmp4ToMp4(fmp4Source);
const sourceParser = new MP4Parser(standardMp4);
const sourceKeyframes = sourceParser.getVideoSamples().filter(s => s.isKeyframe);

// ── Tests ─────────────────────────────────────────────────

const tests = [

  test('clipMp4 produces valid MP4 structure', async () => {
    const clipped = clipMp4(standardMp4, { startTime: 1, endTime: 5 });
    const boxes = parseBoxes(clipped);
    assert(findBox(boxes, 'ftyp'), 'Must have ftyp');
    assert(findBox(boxes, 'moov'), 'Must have moov');
    assert(findBox(boxes, 'mdat'), 'Must have mdat');
    assert(!findBox(boxes, 'moof'), 'Must not have moof');
    console.log(`   Output: ${(clipped.byteLength / 1024).toFixed(1)} KB`);
  }),

  test('clipMp4 duration matches requested range', async () => {
    const startTime = 2;
    const endTime = 7;
    const clipped = clipMp4(standardMp4, { startTime, endTime });

    // mvhd duration is the playback duration (what the player reports)
    const playbackDur = getMvhdDuration(clipped);

    console.log(`   Requested: ${endTime - startTime}s, Playback (mvhd): ${playbackDur.toFixed(3)}s`);
    assertApprox(playbackDur, endTime - startTime, 0.5,
      'Playback duration should match requested range');
  }),

  test('clipMp4 between keyframes uses edit list preroll', async () => {
    const samples = sourceParser.getVideoSamples();
    const nonKey = samples.find(s => !s.isKeyframe && s.time > 2);
    assert(nonKey, 'Need non-keyframe sample');

    const startTime = nonKey.time;
    const endTime = Math.min(sourceParser.duration, startTime + 3);
    const clipped = clipMp4(standardMp4, { startTime, endTime });

    const { video } = inspectTracks(clipped);
    assert(video.elst, 'Video must have edit list for non-keyframe clip');
    assert(video.elst.mediaTime > 0, 'Edit list media_time must be > 0');

    const prerollSec = video.elst.mediaTime / video.timescale;
    console.log(`   Start: ${startTime.toFixed(3)}s, Preroll: ${prerollSec.toFixed(3)}s`);
  }),

  test('clipMp4 A/V stays in sync', async () => {
    const samples = sourceParser.getVideoSamples();
    const nonKey = samples.find(s => !s.isKeyframe && s.time > 2);

    const startTime = nonKey.time;
    const endTime = Math.min(sourceParser.duration, startTime + 3);
    const clipped = clipMp4(standardMp4, { startTime, endTime });

    const { video, audio } = inspectTracks(clipped);
    assert(video, 'Must have video');
    assert(audio, 'Must have audio');

    const videoDur = video.mediaDuration / video.timescale;
    const audioDur = audio.mediaDuration / audio.timescale;
    const diff = Math.abs(videoDur - audioDur);

    console.log(`   Video mdat: ${videoDur.toFixed(3)}s, Audio mdat: ${audioDur.toFixed(3)}s, diff: ${diff.toFixed(3)}s`);
    assertApprox(videoDur, audioDur, AAC_FRAME_TOLERANCE,
      'Video and audio media durations must match');

    // Both tracks should have matching preroll
    assert(video.elst, 'Video needs edit list');
    assert(audio.elst, 'Audio needs edit list');
    const vPreroll = video.elst.mediaTime / video.timescale;
    const aPreroll = audio.elst.mediaTime / audio.timescale;
    assertApprox(vPreroll, aPreroll, AAC_FRAME_TOLERANCE,
      'Video and audio preroll must match');
  }),

  test('clipMp4 at keyframe needs no preroll', async () => {
    const kf = sourceKeyframes[0];
    const endTime = Math.min(sourceParser.duration, kf.time + 3);
    const clipped = clipMp4(standardMp4, { startTime: kf.time, endTime });

    const { video } = inspectTracks(clipped);
    if (video.elst) {
      const preroll = video.elst.mediaTime / video.timescale;
      assertApprox(preroll, 0, 0.001, 'Keyframe clip should have 0 preroll');
    }
    console.log(`   Clipped at keyframe ${kf.time.toFixed(3)}s — no preroll needed`);
  }),

  test('clipMp4 output is playable (re-parseable)', async () => {
    const clipped = clipMp4(standardMp4, { startTime: 3, endTime: 8 });
    const parser = new MP4Parser(clipped);
    const vSamples = parser.getVideoSamples();
    const aSamples = parser.getAudioSamples();

    assert(vSamples.length > 0, 'Must have video samples');
    assert(aSamples.length > 0, 'Must have audio samples');
    assert(vSamples[0].isKeyframe, 'First video sample must be a keyframe');

    console.log(`   ${vSamples.length} video + ${aSamples.length} audio samples, first is keyframe`);
  }),

  test('toMp4() routes MP4 with clip options through clipMp4', async () => {
    const result = await toMp4(standardMp4, { startTime: 1, endTime: 5 });
    assert(result.data.byteLength > 0, 'Should produce output');
    assert(result.data.byteLength < standardMp4.byteLength, 'Clipped should be smaller than source');

    const playbackDur = getMvhdDuration(result.data);
    assertApprox(playbackDur, 4, 0.5, 'Playback duration should be ~4s');
    console.log(`   toMp4() routed to clipMp4, playback (mvhd): ${playbackDur.toFixed(3)}s`);
  }),

  test('toMp4() passes MP4 through unchanged without clip options', async () => {
    const result = await toMp4(standardMp4);
    assert(result.data.byteLength === standardMp4.byteLength,
      'Without clip options, MP4 should pass through unchanged');
    console.log(`   Pass-through: ${result.data.byteLength} bytes (unchanged)`);
  }),

];

// ── runner ─────────────────────────────────────────────────

async function runTests(tests) {
  console.log('\n' + '='.repeat(60));
  console.log('   MP4-to-MP4 Clip Tests');
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
