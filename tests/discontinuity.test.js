/**
 * Discontinuity Collapse Tests
 *
 * An edited HLS asset keeps absolute source PTS with an EXT-X-DISCONTINUITY at
 * each cut, so consecutive kept frames jump by seconds. The MP4 video sample
 * table would turn that jump into a multi-second frozen frame (and desync vs
 * audio). collapseVideoDiscontinuities() removes those gaps so video stays
 * continuous and in sync. A no-op on gapless streams.
 *
 * Run: node tests/discontinuity.test.js
 */
import { readFileSync } from 'node:fs';
import { collapseVideoDiscontinuities, convertTsToMp4WithSeparateAudio } from '../src/ts-to-mp4.js';

let passed = 0, failed = 0;
const test = (name, fn) => ({ name, fn });
const assert = (c, m) => { if (!c) throw new Error(m || 'Assertion failed'); };
const assertApprox = (a, e, tol, m) => { if (Math.abs(a - e) > tol) throw new Error(`${m}: expected ~${e}, got ${a}`); };

function fakeParser(dtsList) {
  return {
    videoAccessUnits: dtsList.map(d => ({ dts: d, pts: d, nalUnits: [] })),
    videoDts: dtsList.slice(),
    videoPts: dtsList.slice(),
  };
}
function maxGap(dts) {
  let m = 0;
  for (let i = 1; i < dts.length; i++) m = Math.max(m, dts[i] - dts[i - 1]);
  return m;
}
// mvhd duration (seconds) — video track drives the movie duration here
function mvhdDurationSec(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const walk = (o, end) => {
    while (o + 8 <= end) {
      const size = view.getUint32(o);
      if (size < 8) break;
      const t = String.fromCharCode(data[o + 4], data[o + 5], data[o + 6], data[o + 7]);
      if (t === 'mvhd') {
        const version = data[o + 8];
        const ts = version === 1 ? view.getUint32(o + 28) : view.getUint32(o + 20);
        const dur = version === 1 ? Number(view.getBigUint64(o + 32)) : view.getUint32(o + 24);
        return dur / ts;
      }
      if (t === 'moov') { const r = walk(o + 8, o + size); if (r) return r; }
      o += size;
    }
    return null;
  };
  return walk(0, data.byteLength);
}

const FIX = './tests/fixtures/hls-ts';

const tests = [
  test('unit: a large gap is collapsed to one nominal frame', () => {
    // 30fps => 3000 ticks/frame @ 90kHz. Insert a 4s (360000) gap after frame 3.
    const dts = [0, 3000, 6000, 9000, 9000 + 363000, 9000 + 366000, 9000 + 369000];
    const p = fakeParser(dts);
    const n = collapseVideoDiscontinuities(p);
    assert(n === 1, `one gap collapsed, got ${n}`);
    assert(maxGap(p.videoDts) <= 3000, `no gap should remain, max=${maxGap(p.videoDts)}`);
    assert(p.videoDts[4] === 12000, `frame after gap continues (got ${p.videoDts[4]})`);
    // pts shifted identically so composition offset (pts-dts) is preserved
    assert(p.videoAccessUnits[4].pts === p.videoAccessUnits[4].dts, 'pts/dts stay coherent');
  }),

  test('unit: two gaps both collapse and accumulate', () => {
    const dts = [0, 3000, 6000, 6000 + 300000, 6000 + 303000, 6000 + 303000 + 600000, 6000 + 306000 + 600000];
    const p = fakeParser(dts);
    const n = collapseVideoDiscontinuities(p);
    assert(n === 2, `two gaps, got ${n}`);
    assert(maxGap(p.videoDts) <= 3000, `continuous after collapse, max=${maxGap(p.videoDts)}`);
  }),

  test('unit: gapless stream is untouched (no-op)', () => {
    const dts = [0, 3000, 6000, 9000, 12000, 15000];
    const p = fakeParser(dts);
    const n = collapseVideoDiscontinuities(p);
    assert(n === 0, `no gaps, got ${n}`);
    assert(JSON.stringify(p.videoDts) === JSON.stringify([0, 3000, 6000, 9000, 12000, 15000]), 'unchanged');
  }),

  test('unit: normal frame-rate jitter is NOT collapsed', () => {
    // small ±1 tick wobble around 3000 must never trip the threshold
    const dts = [0, 2999, 6001, 9000, 11998, 15002];
    const p = fakeParser(dts);
    assert(collapseVideoDiscontinuities(p) === 0, 'jitter must not collapse');
  }),

  test('integration: edited (discontinuous) archive muxes to a CONTINUOUS, synced MP4', () => {
    const editedVideo = new Uint8Array(readFileSync(`${FIX}/edited-video.ts`));
    const editedAudio = new Uint8Array(readFileSync(`${FIX}/edited-audio.ts`));
    const out = convertTsToMp4WithSeparateAudio(editedVideo, editedAudio);
    // The fixture cut 3s-6s from a 9s archive => ~6s of kept content. Without
    // the collapse the movie duration would be ~9-10s (a frozen 3-4s frame).
    const dur = mvhdDurationSec(out);
    assertApprox(dur, 6.0, 1.5, 'edited download duration reflects the CUT (no gap)');
    assert(dur < 8.0, `must not carry the ~10s gapped span (got ${dur.toFixed(2)}s)`);
  }),
];

(async () => {
  console.log('\n' + '='.repeat(60) + '\n   Discontinuity Collapse Tests\n' + '='.repeat(60) + '\n');
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`✅ ${name}`); passed++; }
    catch (e) { console.log(`❌ ${name}\n   Error: ${e.message}`); failed++; }
  }
  console.log('\n' + '-'.repeat(60) + `\nResults: ${passed} passed, ${failed} failed\n` + '-'.repeat(60) + '\n');
  process.exit(failed > 0 ? 1 : 0);
})();
