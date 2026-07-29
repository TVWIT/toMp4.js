/**
 * HLS Demuxed Audio Group Tests
 *
 * inv-stream (and many packagers) deliver audio as a separate rendition
 * (#EXT-X-MEDIA:TYPE=AUDIO), so the video variant's segments are video-only.
 * These tests verify tomp4 (a) parses the audio group, (b) picks the right
 * rendition, and (c) muxes the separate audio track into the MP4 — without it
 * the download is silent.
 *
 * Run: node tests/hls-audio-group.test.js
 */
import { readFileSync } from 'node:fs';
import { parsePlaylistText, resolveAudioRendition } from '../src/hls.js';
import { convertTsToMp4WithSeparateAudio, convertTsToMp4 } from '../src/index.js';

let passed = 0, failed = 0;
const test = (name, fn) => ({ name, fn });
const assert = (c, m) => { if (!c) throw new Error(m || 'Assertion failed'); };
const assertApprox = (a, e, tol, m) => { if (Math.abs(a - e) > tol) throw new Error(`${m}: expected ~${e}, got ${a}`); };

// ── MP4 box helpers ───────────────────────────────────────
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
// Search for a codec fourcc (avc1/mp4a/hvc1) within the moov metadata only, so
// random matching bytes in mdat can't cause a false positive.
function hasBoxDeep(data, fourcc) {
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
  let off = 0;
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
const videoOnly = new Uint8Array(readFileSync(`${FIX}/video-only.ts`));
const audioOnly = new Uint8Array(readFileSync(`${FIX}/audio-only.ts`));

const MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:4',
  '#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/playlist.m3u8",GROUP-ID="aac",LANGUAGE="en",NAME="English",DEFAULT=YES,AUTOSELECT=YES',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.64001E,mp4a.40",AUDIO="aac"',
  '360p/playlist.m3u8',
].join('\n');

const tests = [
  test('parses #EXT-X-MEDIA audio rendition and variant AUDIO group', () => {
    const { variants, audioRenditions } = parsePlaylistText(MASTER, 'https://x.test/master.m3u8');
    assert(variants.length === 1, 'one variant');
    assert(variants[0].audioGroup === 'aac', `variant.audioGroup should be aac, got ${variants[0].audioGroup}`);
    assert(audioRenditions.length === 1, `one audio rendition, got ${audioRenditions.length}`);
    assert(audioRenditions[0].groupId === 'aac', 'group id');
    assert(audioRenditions[0].isDefault === true, 'default flag');
    assert(audioRenditions[0].url === 'https://x.test/audio/playlist.m3u8', `resolved url, got ${audioRenditions[0].url}`);
  }),

  test('a URI-less muxed-audio EXT-X-MEDIA is ignored (no false rendition)', () => {
    const muxed = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="mux",DEFAULT=YES\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="aud"\nv.m3u8';
    const { audioRenditions } = parsePlaylistText(muxed, 'https://x.test/m.m3u8');
    assert(audioRenditions.length === 0, 'URI-less rendition must not be collected');
  }),

  test('resolveAudioRendition: group match, then DEFAULT, then first', () => {
    const stream = { audioRenditions: [
      { groupId: 'aac-lo', isDefault: false, url: 'a' },
      { groupId: 'aac-hi', isDefault: true, url: 'b' },
    ] };
    assert(resolveAudioRendition(stream, { audioGroup: 'aac-lo' }).url === 'a', 'group match');
    assert(resolveAudioRendition(stream, { audioGroup: 'nope' }).url === 'b', 'fallback to DEFAULT');
    assert(resolveAudioRendition({ audioRenditions: [{ url: 'c' }] }, {}).url === 'c', 'fallback to first');
    assert(resolveAudioRendition({ audioRenditions: [] }, {}) === null, 'none => null');
  }),

  test('convertTsToMp4 on a video-only rendition alone is SILENT (documents the gap)', () => {
    const out = convertTsToMp4(videoOnly);
    assert(hasBoxDeep(out, 'avc1'), 'video track present');
    assert(!hasBoxDeep(out, 'mp4a'), 'video-only input must have no audio track');
  }),

  test('convertTsToMp4WithSeparateAudio muxes BOTH tracks (audible download)', () => {
    const out = convertTsToMp4WithSeparateAudio(videoOnly, audioOnly);
    assert(hasBoxDeep(out, 'avc1'), 'video track present');
    assert(hasBoxDeep(out, 'mp4a'), 'audio track present (the fix)');
    const dur = mvhdDurationSec(out);
    assertApprox(dur, 9.5, 2.0, 'duration matches the ~9-10s source');
  }),
];

(async () => {
  console.log('\n' + '='.repeat(60) + '\n   HLS Demuxed Audio Group Tests\n' + '='.repeat(60) + '\n');
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`✅ ${name}`); passed++; }
    catch (e) { console.log(`❌ ${name}\n   Error: ${e.message}`); failed++; }
  }
  console.log('\n' + '-'.repeat(60) + `\nResults: ${passed} passed, ${failed} failed\n` + '-'.repeat(60) + '\n');
  process.exit(failed > 0 ? 1 : 0);
})();
