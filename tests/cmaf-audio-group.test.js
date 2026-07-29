/**
 * CMAF (fMP4) Demuxed Audio Group Tests
 *
 * inv-stream's production archives are CMAF (fMP4) with a separate
 * #EXT-X-MEDIA:TYPE=AUDIO rendition — so the video variant's .m4s are
 * video-only. These verify convertFmp4WithSeparateAudio muxes the separate
 * audio track (else the download is silent), and that an EDITED (discontinuous)
 * CMAF asset stays continuous (the fMP4 sample table is duration-based, so no
 * frozen frame — no explicit collapse needed).
 *
 * Run: node tests/cmaf-audio-group.test.js
 */
import { readFileSync } from 'node:fs';
import { convertFmp4WithSeparateAudio, convertFmp4ToMp4 } from '../src/index.js';

let passed = 0, failed = 0;
const test = (name, fn) => ({ name, fn });
const assert = (c, m) => { if (!c) throw new Error(m || 'Assertion failed'); };
const assertApprox = (a, e, tol, m) => { if (Math.abs(a - e) > tol) throw new Error(`${m}: expected ~${e}, got ${a}`); };

// Search for a codec fourcc within the moov metadata only (no mdat false positives).
function findTopBox(data, type) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 0;
  while (o + 8 <= data.byteLength) {
    const size = view.getUint32(o);
    if (size < 8) break;
    const t = String.fromCharCode(data[o + 4], data[o + 5], data[o + 6], data[o + 7]);
    if (t === type) return { offset: o, size };
    o += size;
  }
  return null;
}
function hasCodec(data, fourcc) {
  const moov = findTopBox(data, 'moov');
  if (!moov) return false;
  const b = [...fourcc].map(c => c.charCodeAt(0));
  for (let i = moov.offset; i + 4 <= moov.offset + moov.size; i++) {
    if (data[i] === b[0] && data[i + 1] === b[1] && data[i + 2] === b[2] && data[i + 3] === b[3]) return true;
  }
  return false;
}
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

const FIX = './tests/fixtures/hls-cmaf';
const vraw = new Uint8Array(readFileSync(`${FIX}/video-only.fmp4`));
const araw = new Uint8Array(readFileSync(`${FIX}/audio-only.fmp4`));
const vedit = new Uint8Array(readFileSync(`${FIX}/edited-video.fmp4`));
const aedit = new Uint8Array(readFileSync(`${FIX}/edited-audio.fmp4`));

const tests = [
  test('convertFmp4ToMp4 on the CMAF video rendition alone is SILENT (documents the gap)', () => {
    const out = convertFmp4ToMp4(vraw);
    assert(hasCodec(out, 'avc1'), 'video track present');
    assert(!hasCodec(out, 'mp4a'), 'video-only CMAF must have no audio track');
  }),

  test('convertFmp4WithSeparateAudio muxes BOTH tracks (audible CMAF download)', () => {
    const out = convertFmp4WithSeparateAudio(vraw, araw);
    assert(hasCodec(out, 'avc1'), 'video track present');
    assert(hasCodec(out, 'mp4a'), 'audio track present (the fix)');
    assertApprox(mvhdDurationSec(out), 9.5, 2.0, 'duration matches the ~9-10s source');
  }),

  test('edited (discontinuous) CMAF muxes to a CONTINUOUS, audible MP4', () => {
    const out = convertFmp4WithSeparateAudio(vedit, aedit);
    assert(hasCodec(out, 'avc1') && hasCodec(out, 'mp4a'), 'both tracks present');
    // The fixture cut 3s-6s from a 9s archive => ~6s kept. The fMP4 sample table
    // is duration-based, so the discontinuity never becomes a frozen span.
    const dur = mvhdDurationSec(out);
    assertApprox(dur, 6.0, 1.5, 'edited CMAF duration reflects the CUT');
    assert(dur < 8.0, `must not carry the ~9s gapped span (got ${dur.toFixed(2)}s)`);
  }),

  test('output is a valid standard MP4 (ftyp + moov + mdat)', () => {
    const out = convertFmp4WithSeparateAudio(vraw, araw);
    assert(findTopBox(out, 'ftyp'), 'has ftyp');
    assert(findTopBox(out, 'moov'), 'has moov');
    assert(findTopBox(out, 'mdat'), 'has mdat');
    assert(!findTopBox(out, 'moof'), 'must be defragmented (no moof)');
  }),
];

(async () => {
  console.log('\n' + '='.repeat(60) + '\n   CMAF Demuxed Audio Group Tests\n' + '='.repeat(60) + '\n');
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`✅ ${name}`); passed++; }
    catch (e) { console.log(`❌ ${name}\n   Error: ${e.message}`); failed++; }
  }
  console.log('\n' + '-'.repeat(60) + `\nResults: ${passed} passed, ${failed} failed\n` + '-'.repeat(60) + '\n');
  process.exit(failed > 0 ? 1 : 0);
})();
