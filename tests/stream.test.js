/**
 * Streaming-to-disk Tests
 *
 * Verifies output can be written incrementally to a StreamTarget without
 * buffering the whole file: streamMp3 is byte-identical to encodeMp3, and the
 * streaming MP4 muxer emits a valid mdat-first MP4 (correct 64-bit mdat size,
 * ftyp+mdat+moov, both tracks) using many small writes — matching the in-memory
 * converter's decoded result. When ffmpeg is present it also decodes the
 * streamed MP4 and checks duration + no errors.
 *
 * Run: node tests/stream.test.js
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { encodeMp3, streamMp3, convertFmp4WithSeparateAudio, ArrayBufferTarget } from '../src/index.js';
import { streamFmp4SeparateAudio } from '../src/stream/mp4.js';
import { parseBoxes } from '../src/fmp4/utils.js';

let passed = 0, failed = 0;
const test = (name, fn) => ({ name, fn });
const assert = (c, m) => { if (!c) throw new Error(m || 'Assertion failed'); };
const assertApprox = (a, e, tol, m) => { if (Math.abs(a - e) > tol) throw new Error(`${m}: expected ~${e}, got ${a}`); };

// Split a concatenated fMP4 into its init segment + individual media segments.
function splitFmp4(bytes) {
  const boxes = parseBoxes(bytes);
  let initEnd = 0; const segs = []; let cur = null;
  for (const b of boxes) {
    if (b.type === 'ftyp' || b.type === 'moov') { initEnd = b.offset + b.size; continue; }
    if (b.type === 'moof') cur = b.offset;
    else if (b.type === 'mdat' && cur != null) { segs.push(bytes.subarray(cur, b.offset + b.size)); cur = null; }
  }
  return { init: bytes.subarray(0, initEnd), segs };
}

// Read top-level boxes (handling 64-bit largesize) as {type, start, size}.
function topBoxes(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = []; let o = 0;
  while (o + 8 <= data.length) {
    let size = view.getUint32(o);
    const type = String.fromCharCode(data[o + 4], data[o + 5], data[o + 6], data[o + 7]);
    let headed = 8;
    if (size === 1) { size = Number(view.getBigUint64(o + 8)); headed = 16; }
    out.push({ type, start: o, size, headerSize: headed });
    if (size < headed) break;
    o += size;
  }
  return out;
}
function hasCodec(data, fourcc) {
  const moov = topBoxes(data).find((b) => b.type === 'moov');
  if (!moov) return false;
  const b = [...fourcc].map((c) => c.charCodeAt(0));
  for (let i = moov.start; i + 4 <= moov.start + moov.size; i++)
    if (data[i] === b[0] && data[i + 1] === b[1] && data[i + 2] === b[2] && data[i + 3] === b[3]) return true;
  return false;
}
function mvhdDurationSec(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // locate moov via the largesize-aware top scan, then find mvhd inside it
  const moov = topBoxes(data).find((b) => b.type === 'moov');
  if (!moov) return null;
  let o = moov.start + 8;
  const end = moov.start + moov.size;
  while (o + 8 <= end) {
    const size = view.getUint32(o);
    if (size < 8) break;
    const t = String.fromCharCode(data[o + 4], data[o + 5], data[o + 6], data[o + 7]);
    if (t === 'mvhd') { const v = data[o + 8]; const ts = v === 1 ? view.getUint32(o + 28) : view.getUint32(o + 20); const d = v === 1 ? Number(view.getBigUint64(o + 32)) : view.getUint32(o + 24); return d / ts; }
    o += size;
  }
  return null;
}

let hasFfmpeg = false;
try { execSync('ffmpeg -version', { stdio: 'ignore' }); hasFfmpeg = true; } catch { /* skip */ }

const FIX = './tests/fixtures/hls-cmaf';
async function streamCmaf(vf, af) {
  const V = splitFmp4(new Uint8Array(readFileSync(`${FIX}/${vf}`)));
  const A = splitFmp4(new Uint8Array(readFileSync(`${FIX}/${af}`)));
  const target = new ArrayBufferTarget();
  let writes = 0; const w = target.write.bind(target); target.write = (c) => { writes++; return w(c); };
  await streamFmp4SeparateAudio({ videoInit: V.init, audioInit: A.init, videoSegments: V.segs, audioSegments: A.segs }, target);
  return { bytes: target.buffer, writes, vsegs: V.segs.length, asegs: A.segs.length };
}

const tests = [
  test('ArrayBufferTarget: write + positional writeAt', async () => {
    const t = new ArrayBufferTarget();
    await t.write(new Uint8Array([1, 2, 3, 4]));
    await t.write(new Uint8Array([5, 6]));
    assert(t.position === 6, 'append position');
    await t.writeAt(1, new Uint8Array([9, 9]));       // patch earlier bytes
    assert([...t.buffer].join(',') === '1,9,9,4,5,6', `patched buffer, got ${[...t.buffer]}`);
    await t.write(new Uint8Array([7]));               // append still lands at the end
    assert([...t.buffer].join(',') === '1,9,9,4,5,6,7', 'append after writeAt');
  }),

  test('streamMp3 is byte-identical to encodeMp3', async () => {
    const n = 48000, L = new Int16Array(n), R = new Int16Array(n);
    for (let i = 0; i < n; i++) { L[i] = Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / 48000)); R[i] = Math.round(6000 * Math.sin(2 * Math.PI * 660 * i / 48000)); }
    const buffered = encodeMp3([L, R], { sampleRate: 48000, bitRate: 128 }).data;
    const target = new ArrayBufferTarget();
    let writes = 0; const w = target.write.bind(target); target.write = (c) => { writes++; return w(c); };
    await streamMp3([L, R], target, { sampleRate: 48000, bitRate: 128 });
    const streamed = target.buffer;
    assert(writes > 3, `streamed in multiple writes, got ${writes}`);
    assert(streamed.length === buffered.length && streamed.every((b, i) => b === buffered[i]),
      `streamed MP3 must equal encodeMp3 (len ${streamed.length} vs ${buffered.length})`);
  }),

  test('streamFmp4SeparateAudio: incremental writes, valid mdat-first MP4, both tracks', async () => {
    const { bytes, writes, vsegs, asegs } = await streamCmaf('video-only.fmp4', 'audio-only.fmp4');
    assert(writes > vsegs + asegs + 10, `many incremental writes (got ${writes} for ${vsegs}+${asegs} segs)`);
    const boxes = topBoxes(bytes);
    assert(boxes[0].type === 'ftyp', 'starts with ftyp');
    assert(boxes[1].type === 'mdat', 'mdat is second (streaming layout)');
    assert(boxes[2].type === 'moov', 'moov is last');
    // the 64-bit mdat size must exactly span to the moov
    assert(boxes[1].start + boxes[1].size === boxes[2].start, 'mdat largesize spans to moov');
    assert(boxes[1].headerSize === 16, 'mdat uses 64-bit largesize header');
    assert(hasCodec(bytes, 'avc1') && hasCodec(bytes, 'mp4a'), 'both video + audio tracks present');
    assertApprox(mvhdDurationSec(bytes), 9.0, 1.5, 'duration matches the ~9s source');
  }),

  test('streamed edited (discontinuous) CMAF is valid + continuous', async () => {
    const { bytes } = await streamCmaf('edited-video.fmp4', 'edited-audio.fmp4');
    assert(hasCodec(bytes, 'avc1') && hasCodec(bytes, 'mp4a'), 'both tracks');
    const dur = mvhdDurationSec(bytes);
    assertApprox(dur, 6.0, 1.5, 'edited duration reflects the cut');
    assert(dur < 8.0, `no gap carried (got ${dur.toFixed(2)}s)`);
  }),

  test(`streamed MP4 decodes cleanly, matching in-memory${hasFfmpeg ? '' : ' (SKIPPED: no ffmpeg)'}`, async () => {
    if (!hasFfmpeg) return;
    const { bytes } = await streamCmaf('video-only.fmp4', 'audio-only.fmp4');
    const inmem = convertFmp4WithSeparateAudio(
      new Uint8Array(readFileSync(`${FIX}/video-only.fmp4`)),
      new Uint8Array(readFileSync(`${FIX}/audio-only.fmp4`)));
    const dir = mkdtempSync(join(tmpdir(), 'strm-'));
    const sp = join(dir, 's.mp4'), ip = join(dir, 'i.mp4');
    writeFileSync(sp, bytes); writeFileSync(ip, inmem);
    const dur = (p) => parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).toString());
    // full decode of the streamed file (execFileSync throws if ffmpeg errors)
    execFileSync('ffmpeg', ['-v', 'error', '-i', sp, '-f', 'null', '-']);
    assertApprox(dur(sp), dur(ip), 0.1, 'streamed vs in-memory duration');
  }),
];

(async () => {
  console.log('\n' + '='.repeat(60) + '\n   Streaming-to-disk Tests' + (hasFfmpeg ? '' : '  (decode check skipped: no ffmpeg)') + '\n' + '='.repeat(60) + '\n');
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`✅ ${name}`); passed++; }
    catch (e) { console.log(`❌ ${name}\n   Error: ${e.message}`); failed++; }
  }
  console.log('\n' + '-'.repeat(60) + `\nResults: ${passed} passed, ${failed} failed\n` + '-'.repeat(60) + '\n');
  process.exit(failed > 0 ? 1 : 0);
})();
