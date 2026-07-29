/**
 * MP3 Encoder Tests
 *
 * Validates the from-scratch MPEG-1/2 Layer III encoder: every emitted frame is
 * a well-formed MP3 frame (sync word, layer, bitrate/samplerate/channel fields)
 * whose size tiles the output exactly, across mono/stereo and 44.1/48kHz. When
 * ffmpeg is available it also decodes a 440Hz tone and checks (via Goertzel)
 * that the tone dominates and the level is correct (no clipping / not silent).
 *
 * Run: node tests/mp3.test.js
 */
import { Mp3Encoder } from '../src/mp3/encoder.js';
import { execSync, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0, failed = 0;
const test = (name, fn) => ({ name, fn });
const assert = (c, m) => { if (!c) throw new Error(m || 'Assertion failed'); };

const SR_TABLE = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const BR_MPEG1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

/** Walk the MP3, decode each frame header, assert it tiles the buffer exactly. */
function validateFrames(mp3, expect) {
  let pos = 0, frames = 0;
  while (pos + 4 <= mp3.length) {
    const h = (mp3[pos] << 24) | (mp3[pos + 1] << 16) | (mp3[pos + 2] << 8) | mp3[pos + 3];
    assert(((h >>> 21) & 0x7ff) === 0x7ff, `frame ${frames}: bad sync at ${pos}`);
    const ver = (h >>> 19) & 0x3;
    const layer = (h >>> 17) & 0x3;
    const brIdx = (h >>> 12) & 0xf;
    const srIdx = (h >>> 10) & 0x3;
    const padding = (h >>> 9) & 0x1;
    const mode = (h >>> 6) & 0x3;
    assert(layer === 1, `frame ${frames}: layer must be III (01), got ${layer}`);
    assert(ver === expect.ver, `frame ${frames}: version ${ver} != ${expect.ver}`);
    assert(srIdx < 3, `frame ${frames}: bad samplerate index`);
    const sampleRate = SR_TABLE[ver][srIdx];
    assert(sampleRate === expect.sampleRate, `frame ${frames}: sr ${sampleRate} != ${expect.sampleRate}`);
    const kbps = BR_MPEG1[brIdx];
    assert(kbps === expect.kbps, `frame ${frames}: bitrate ${kbps} != ${expect.kbps}`);
    const channels = mode === 3 ? 1 : 2;
    assert(channels === expect.channels, `frame ${frames}: channels ${channels} != ${expect.channels}`);
    const spf = ver === 3 ? 1152 : 576;
    const frameLen = Math.floor((spf / 8) * kbps * 1000 / sampleRate) + padding;
    assert(frameLen > 4, `frame ${frames}: implausible length ${frameLen}`);
    pos += frameLen;
    frames++;
  }
  assert(pos === mp3.length, `frames do not tile the buffer (ended at ${pos}/${mp3.length})`);
  return frames;
}

function encodeTone(channels, sampleRate, kbps, freq, seconds, amp = 8000) {
  const n = Math.floor(sampleRate * seconds);
  const L = new Int16Array(n), R = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = Math.round(amp * Math.sin(2 * Math.PI * freq * i / sampleRate));
    R[i] = Math.round(amp * Math.sin(2 * Math.PI * (freq * 1.5) * i / sampleRate));
  }
  const enc = new Mp3Encoder(channels, sampleRate, kbps);
  const parts = [];
  for (let i = 0; i < n; i += 1152) {
    parts.push(channels === 2
      ? enc.encodeBuffer(L.subarray(i, i + 1152), R.subarray(i, i + 1152))
      : enc.encodeBuffer(L.subarray(i, i + 1152)));
  }
  parts.push(enc.flush());
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Goertzel single-bin energy at frequency f.
function goertzel(x, sampleRate, f) {
  const w = 2 * Math.PI * f / sampleRate, cr = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) { s0 = x[i] + cr * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(s1 * s1 + s2 * s2 - cr * s1 * s2);
}

let hasFfmpeg = false;
try { execSync('ffmpeg -version', { stdio: 'ignore' }); hasFfmpeg = true; } catch { /* skip audio check */ }

const tests = [
  test('stereo 48kHz/128 — valid frames tile the output', () => {
    const mp3 = encodeTone(2, 48000, 128, 440, 1);
    const frames = validateFrames(mp3, { ver: 3, sampleRate: 48000, kbps: 128, channels: 2 });
    assert(Math.abs(frames * 1152 / 48000 - 1) < 0.06, `~1s of frames, got ${frames}`);
  }),

  test('mono 48kHz/64 — valid frames', () => {
    validateFrames(encodeTone(1, 48000, 64, 440, 0.5), { ver: 3, sampleRate: 48000, kbps: 64, channels: 1 });
  }),

  test('stereo 44.1kHz/128 — padding frames tile exactly', () => {
    // 44.1kHz has fractional slots → alternating padding; frames must still tile.
    validateFrames(encodeTone(2, 44100, 128, 440, 0.5), { ver: 3, sampleRate: 44100, kbps: 128, channels: 2 });
  }),

  test('stereo 48kHz/192 — valid frames', () => {
    validateFrames(encodeTone(2, 48000, 192, 1000, 0.5), { ver: 3, sampleRate: 48000, kbps: 192, channels: 2 });
  }),

  test('rejects unsupported sample rate / bitrate', () => {
    let threw = 0;
    try { new Mp3Encoder(2, 47000, 128); } catch { threw++; }
    try { new Mp3Encoder(2, 48000, 130); } catch { threw++; }
    assert(threw === 2, 'both invalid configs must throw');
  }),

  test(`decoded 440Hz tone dominates + correct level${hasFfmpeg ? '' : ' (SKIPPED: no ffmpeg)'}`, () => {
    if (!hasFfmpeg) return;
    const amp = 10000;
    const mp3 = encodeTone(1, 48000, 128, 440, 2, amp);
    const dir = mkdtempSync(join(tmpdir(), 'mp3t-'));
    const mp3Path = join(dir, 't.mp3'), pcmPath = join(dir, 't.raw');
    writeFileSync(mp3Path, mp3);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', mp3Path, '-f', 's16le', '-ac', '1', '-ar', '48000', pcmPath]);
    const buf = execFileSync('cat', [pcmPath]);
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
    const mid = Array.from(pcm.subarray(24000, 24000 + 24000));
    const e440 = goertzel(mid, 48000, 440);
    const e880 = goertzel(mid, 48000, 880);
    const e1061 = goertzel(mid, 48000, 1061); // the alias image, must be tiny
    assert(e440 > 30 * e880 && e440 > 30 * e1061, `tone must dominate (440:${e440|0} 880:${e880|0} 1061:${e1061|0})`);
    let sq = 0; for (const v of pcm.subarray(20000, 80000)) sq += v * v;
    const rms = Math.sqrt(sq / 60000), inRms = amp / Math.SQRT2;
    assert(rms / inRms > 0.7 && rms / inRms < 1.4, `level within ~unity, got ${(rms / inRms).toFixed(2)}x`);
    let peak = 0; for (const v of pcm) peak = Math.max(peak, Math.abs(v));
    assert(peak < 32767, `must not clip, peak ${peak}`);
  }),
];

(async () => {
  console.log('\n' + '='.repeat(60) + '\n   MP3 Encoder Tests' + (hasFfmpeg ? '' : '  (audio check skipped: no ffmpeg)') + '\n' + '='.repeat(60) + '\n');
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`✅ ${name}`); passed++; }
    catch (e) { console.log(`❌ ${name}\n   Error: ${e.message}`); failed++; }
  }
  console.log('\n' + '-'.repeat(60) + `\nResults: ${passed} passed, ${failed} failed\n` + '-'.repeat(60) + '\n');
  process.exit(failed > 0 ? 1 : 0);
})();
