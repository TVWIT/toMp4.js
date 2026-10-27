/**
 * RemoteMp4 (MP4 → HLS on demand) + the parser/muxer fixes it depends on.
 *
 * - Parser: unsigned 32-bit reads, 64-bit offsets, negative ctts, edit lists,
 *   esds, keyframe Set, buildSegments (last frame, keyframe-aligned target).
 * - TS muxer: short PES stuffing, PCR on every video PES, NAL length size.
 * - RemoteMp4 on a real encoded file (generated with ffmpeg; skipped without
 *   it): edit-list A/V alignment matches the source, every audio frame lands
 *   in exactly one segment, playlist rules, OTFP-style errors.
 *
 * Run: node tests/remote-hls.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readUint32, readUint64, readInt32, analyzeTrack, buildSampleTable, buildSegments,
  parseEsds,
} from '../src/parsers/mp4.js';
import { TSMuxer } from '../src/muxers/mpegts.js';
import { RemoteMp4, RemoteMp4Error } from '../src/index.js';
import { clipMp4 } from '../src/mp4-clip.js';

// ---------------------------------------------------------------------------
// Box builders
// ---------------------------------------------------------------------------

const u32 = (n) => [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
const u16 = (n) => [(n >> 8) & 0xFF, n & 0xFF];
const i32 = (n) => u32(n < 0 ? n + 0x100000000 : n);
const flat = (v) => (v instanceof Uint8Array ? Array.from(v) : Array.isArray(v) ? v.flatMap(flat) : [v]);
const bytes = (...parts) => Uint8Array.from(flat(parts));
function box(type, ...payload) {
  const body = bytes(payload);
  return bytes(u32(body.length + 8), [...type].map(c => c.charCodeAt(0)), body);
}
const full = (type, version, payload) => box(type, [version, 0, 0, 0], payload);

/** moov with one H.264 video trak: B-frames (negative v1 ctts), keyframes 1 and 4, an edit list. */
function syntheticMoov({ mediaTime = 1000, emptyEdit = 0 } = {}) {
  const sps = [0x67, 0x4D, 0x40, 0x28, 0xAA];
  const pps = [0x68, 0xEE, 0x3C, 0x80];
  const avcC = box('avcC', [1, 0x4D, 0x40, 0x28, 0xFF, 0xE1], u16(sps.length), sps, [1], u16(pps.length), pps);
  const avc1 = box('avc1', new Array(78).fill(0), avcC); // 78 = 86 - 8 header
  const stsd = full('stsd', 0, [u32(1), avc1]);
  const stts = full('stts', 0, [u32(1), u32(6), u32(1000)]);
  const stss = full('stss', 0, [u32(2), u32(1), u32(4)]);
  // v1 ctts: [2000, -1000, 0, 2000, -1000, 0] (signed)
  const ctts = full('ctts', 1, [u32(6), [2000, -1000, 0, 2000, -1000, 0].map(o => [u32(1), i32(o)])]);
  const stsz = full('stsz', 0, [u32(0), u32(6), [100, 50, 60, 120, 40, 30].map(u32)]);
  const stsc = full('stsc', 0, [u32(1), u32(1), u32(6), u32(1)]);
  const stco = full('stco', 0, [u32(1), u32(4096)]);
  const stbl = box('stbl', stsd, stts, stss, ctts, stsz, stsc, stco);
  const minf = box('minf', stbl);
  const hdlr = full('hdlr', 0, [u32(0), [...'vide'].map(c => c.charCodeAt(0)), new Array(12).fill(0), [0]]);
  const mdhd = full('mdhd', 0, [u32(0), u32(0), u32(30000), u32(6000), u16(0), u16(0)]);
  const mdia = box('mdia', mdhd, hdlr, minf);
  const edits = [];
  if (emptyEdit) edits.push([u32(emptyEdit), i32(-1), u32(0x10000)]);
  edits.push([u32(6000), i32(mediaTime), u32(0x10000)]);
  const elst = full('elst', 0, [u32(edits.length), edits]);
  const edts = box('edts', elst);
  const tkhd = full('tkhd', 0, [u32(0), u32(0), u32(1), u32(0), u32(6000), new Array(52).fill(0), u32(1280 << 16), u32(720 << 16)]);
  const trak = box('trak', tkhd, edts, mdia);
  const mvhd = full('mvhd', 0, [u32(0), u32(0), u32(1000), u32(200), new Array(80).fill(0)]);
  return box('moov', mvhd, trak);
}

function firstTrak(moov) {
  // moov header (8) + mvhd
  const mvhdSize = readUint32(moov, 8);
  const trakOffset = 8 + mvhdSize;
  return analyzeTrack(moov, trakOffset, readUint32(moov, trakOffset));
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

test('readUint32 is unsigned; readInt32 signed; readUint64 keeps the high word', () => {
  assert.equal(readUint32(bytes(0xFF, 0xFF, 0xFF, 0xFE), 0), 0xFFFFFFFE);
  assert.equal(readUint32(bytes(0x80, 0, 0, 0), 0), 2 ** 31);
  assert.equal(readInt32(bytes(0xFF, 0xFF, 0xFF, 0xFF), 0), -1);
  assert.equal(readInt32(bytes(0x7F, 0xFF, 0xFF, 0xFF), 0), 0x7FFFFFFF);
  assert.equal(readUint64(bytes(0, 0, 0, 1, 0, 0, 0, 5), 0), 2 ** 32 + 5); // 4 GB + 5
});

test('analyzeTrack exposes the edit list (media time + leading empty edit)', () => {
  const track = firstTrak(syntheticMoov({ mediaTime: 3003, emptyEdit: 500 }));
  assert.equal(track.edit.mediaTime, 3003 / 30000);
  assert.equal(track.edit.emptyDuration, 500 / 1000); // movie timescale
  assert.equal(track.edit.entryCount, 2);
  assert.deepEqual(Array.from(track.codecConfig.sps[0].slice(0, 4)), [0x67, 0x4D, 0x40, 0x28]);
});

test('buildSampleTable keeps negative (v1) ctts and marks keyframes from stss', () => {
  const samples = buildSampleTable(firstTrak(syntheticMoov()));
  assert.deepEqual(samples.map(s => s.pts * 30000), [2000, 0, 2000, 5000, 3000, 5000]);
  assert.deepEqual(samples.map(s => s.isKeyframe), [true, false, false, true, false, false]);
  assert.deepEqual(samples.map(s => s.offset), [4096, 4196, 4246, 4306, 4426, 4466]);
});

test('parseEsds reads the AudioSpecificConfig (AAC-LC 48 kHz stereo)', () => {
  // esds: ES_Descriptor(3) > DecoderConfig(4) > DecoderSpecificInfo(5) = 0x11 0x90
  const dsi = [0x05, 0x02, 0x11, 0x90];
  const dcd = [0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0, u32(0), u32(0), dsi];
  const esd = [0x03, 3 + dcd.flat(Infinity).length, u16(1), 0, dcd];
  const esds = full('esds', 0, esd);
  const asc = parseEsds(esds, 0, esds.length);
  assert.equal(asc.objectType, 2);
  assert.equal(asc.sampleRate, 48000);
  assert.equal(asc.channelConfiguration, 2);
});

test('buildSegments: keyframe-aligned, last frame included, both boundary rules', () => {
  // 2 s GOPs at 10 fps, 9 s of video (last GOP short).
  const samples = Array.from({ length: 90 }, (_, i) => ({ time: i / 10, duration: 0.1, isKeyframe: i % 20 === 0 }));

  // Default ('before', as in 1.7): GOPs merge only while under the target.
  const before = buildSegments(samples, 4);
  assert.deepEqual(before.map(s => [s.videoStart, s.videoEnd]), [[0, 20], [20, 40], [40, 60], [60, 90]]);
  assert.deepEqual(before.map(s => +s.duration.toFixed(3)), [2, 2, 2, 3]);
  assert.equal(before.at(-1).endTime, 9, 'presentation end includes the last frame');

  // 'after' (ffmpeg hls_time): end at the first keyframe at/after the target.
  const after = buildSegments(samples, 4, { boundary: 'after' });
  assert.deepEqual(after.map(s => [s.videoStart, s.videoEnd]), [[0, 40], [40, 80], [80, 90]]);
  assert.deepEqual(after.map(s => +s.duration.toFixed(3)), [4, 4, 1]);
  assert.equal(after.at(-1).endTime, 9);
});

// ---------------------------------------------------------------------------
// TS muxer
// ---------------------------------------------------------------------------

/** Parse TS packets: returns per-PID payload byte totals and PCR presence on video PES starts. */
function inspectTs(ts) {
  assert.equal(ts.length % 188, 0);
  const out = { pesStarts: 0, pcrOnStarts: 0, payload: new Map() };
  for (let p = 0; p < ts.length; p += 188) {
    assert.equal(ts[p], 0x47, 'sync byte');
    const pid = ((ts[p + 1] & 0x1F) << 8) | ts[p + 2];
    const pusi = (ts[p + 1] & 0x40) !== 0;
    const afc = (ts[p + 3] >> 4) & 3;
    let pos = p + 4;
    let hasPcr = false;
    if (afc & 2) {
      const afLen = ts[pos];
      if (afLen > 0) hasPcr = (ts[pos + 1] & 0x10) !== 0;
      pos += 1 + afLen;
    }
    assert.ok(pos <= p + 188, 'adaptation field fits');
    const len = afc & 1 ? p + 188 - pos : 0;
    if (pid === 0x101 && pusi) {
      out.pesStarts++;
      if (hasPcr) out.pcrOnStarts++;
      assert.deepEqual(Array.from(ts.slice(pos, pos + 3)), [0, 0, 1], 'PES start code right after the AF');
    }
    out.payload.set(pid, (out.payload.get(pid) || 0) + len);
  }
  return out;
}

test('TSMuxer: tiny frames are stuffed correctly and every video PES carries a PCR', () => {
  const m = new TSMuxer();
  m.setSpsPps(bytes(0x67, 1, 2, 3), bytes(0x68, 4));
  const nal = (n) => bytes(u32(n), 0x41, new Array(n - 1).fill(0xAB)); // 4-byte length + slice
  m.addVideoSample(bytes(u32(20), 0x65, new Array(19).fill(1)), true, 9000, 6000);
  m.addVideoSample(nal(10), false, 12000, 9000);   // tiny P-frame: PES < 176 bytes
  m.addVideoSample(nal(500), false, 15000, 12000);
  m.flush();
  const info = inspectTs(m.build());
  assert.equal(info.pesStarts, 3);
  assert.equal(info.pcrOnStarts, 3);
  // PES bytes: 9 + 10 (PTS+DTS) + Annex B (AUD 6 [+ SPS/PPS 14 on keys] + 4-byte start code per NAL).
  // 63 + 39 + 529 — zero padding counted as payload would inflate this.
  assert.equal(info.payload.get(0x101), 631);
});

test('TSMuxer: 2-byte NAL length prefixes convert to Annex B', () => {
  const m = new TSMuxer();
  m.setNalLengthSize(2);
  m.addVideoSample(bytes(u16(3), 0x41, 0xAA, 0xBB, u16(2), 0x41, 0xCC), false, 3000, 3000);
  const ts = m.build();
  const hex = Buffer.from(ts).toString('hex');
  assert.ok(hex.includes('0000000141aabb0000000141cc'), 'both NALs with start codes');
});

// ---------------------------------------------------------------------------
// RemoteMp4 on an encoded file
// ---------------------------------------------------------------------------

let ffmpegOk = false;
try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ffmpegOk = true; } catch {}

/** fetch over an in-memory file, honouring Range like an object store. */
function memoryFetch(file, { status, etag = '"v1"', ignoreRange = false, onRequest } = {}) {
  return async (url, init = {}) => {
    onRequest?.(init);
    if (status) return new Response('x', { status });
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range || '');
    if (!m || ignoreRange) {
      return new Response(file, { status: 200, headers: { 'content-length': String(file.length), etag } });
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), file.length - 1);
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${file.length}`, etag },
    });
  };
}

const probeJson = (path, args) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-of', 'json', ...args, path]).toString());

test('RemoteMp4 on an encoded file', { skip: !ffmpegOk && 'ffmpeg/ffprobe not installed' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tomp4-remote-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, 'src.mp4');
  // 10 s, 30 fps, 1 s GOP, B-frames (edit list for the B-frame delay), AAC 48 kHz (priming edit).
  execFileSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '10', '-c:v', 'libx264', '-profile:v', 'main', '-bf', '2', '-g', '30', '-keyint_min', '30',
    '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', src]);
  const file = new Uint8Array(readFileSync(src));

  const source = await RemoteMp4.fromUrl('mem://src.mp4', { segmentDuration: 4, segmentBoundary: 'after', fetch: memoryFetch(file) });
  const info = source.getInfo();

  await t.test('edit lists are read', () => {
    assert.ok(info.edits.video.mediaTime > 0, 'B-frame delay edit');
    assert.ok(Math.abs(info.edits.audio.mediaTime - 1024 / 48000) < 1e-6, 'AAC priming edit');
  });

  await t.test('segments: keyframe-aligned 4 s, playlist rules', async () => {
    const durs = source.getSegments().map(s => s.duration);
    assert.deepEqual(durs.map(d => +d.toFixed(3)), [4, 4, 2]);
    // Default boundary: segments stay under the target, as in 1.7
    const under = await RemoteMp4.fromUrl('mem://src.mp4', { segmentDuration: 4, fetch: memoryFetch(file) });
    assert.ok(under.getSegments().every(s => s.duration < 4), 'default segments stay under the target');
    const pl = source.getMediaPlaylist('', { segmentName: i => `v-tm${i + 1}.ts` });
    const target = Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(pl)[1]);
    for (const d of durs) assert.ok(Math.round(d) <= target, 'EXTINF rounds to <= target');
    assert.match(pl, /^v-tm1\.ts$/m);
    assert.match(pl, /#EXT-X-ENDLIST\n$/);
    assert.equal(source.getMediaPlaylist('', { start: 4.5, end: 6 }).match(/#EXTINF/g).length, 1, 'slice');
  });

  await t.test('master playlist has CODECS matching the stream', () => {
    const master = source.getMasterPlaylist('', 'v.m3u8');
    assert.match(master, /CODECS="avc1\.4d[0-9a-f]{4},mp4a\.40\.2"/);
    assert.match(master, /RESOLUTION=320x180/);
    assert.match(master, /FRAME-RATE=30\.000/);
  });

  // Concatenate all segments and compare with the source as ffprobe sees it.
  const parts = [];
  for (let i = 0; i < source.segments.length; i++) {
    const ts = await source.getSegment(i);
    writeFileSync(join(dir, `s${i}.ts`), ts);
    parts.push(ts);
  }
  const all = join(dir, 'all.ts');
  writeFileSync(all, Buffer.concat(parts.map(p => Buffer.from(p))));

  await t.test('A/V alignment matches the source (edit lists applied)', () => {
    const first = (path, sel) => Number(probeJson(path, ['-select_streams', sel, '-show_packets', '-read_intervals', '%+#1'])
      .packets[0].pts_time);
    const srcGap = first(src, 'v:0') - first(src, 'a:0');
    const tsGap = first(all, 'v:0') - first(all, 'a:0');
    assert.ok(Math.abs(srcGap - tsGap) < 0.0015, `video-audio start gap ${tsGap.toFixed(4)} vs source ${srcGap.toFixed(4)}`);
  });

  await t.test('every audio and video frame is in exactly one segment', () => {
    const count = (path, sel) => probeJson(path, ['-select_streams', sel, '-count_packets', '-show_entries', 'stream=nb_read_packets'])
      .streams[0].nb_read_packets;
    assert.equal(Number(count(all, 'a:0')), Number(count(src, 'a:0')));
    assert.equal(Number(count(all, 'v:0')), Number(count(src, 'v:0')));
  });

  await t.test('each segment decodes on its own without errors', () => {
    for (let i = 0; i < source.segments.length; i++) {
      const err = execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, `s${i}.ts`), '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
      assert.equal(err.trim(), '', `segment ${i}`);
    }
  });

  await t.test('one origin request per segment for an interleaved file', async () => {
    let requests = 0;
    const s2 = await RemoteMp4.fromUrl('mem://src.mp4', { segmentDuration: 4, fetch: memoryFetch(file, { onRequest: () => requests++ }) });
    requests = 0;
    await s2.getSegment(1);
    assert.equal(requests, 1);
  });

  await t.test('errors mirror OTFP', async () => {
    const err = (opts) => RemoteMp4.fromUrl('mem://x.mp4', { retries: 1, ...opts }).then(() => null, e => e);
    let e = await err({ fetch: memoryFetch(file, { status: 404 }) });
    assert.ok(e instanceof RemoteMp4Error);
    assert.equal(e.status, 404); assert.equal(e.code, 'Origin 404');

    let calls = 0;
    e = await err({ fetch: (u, i) => { calls++; return memoryFetch(file, { status: 503 })(u, i); } });
    assert.equal(e.status, 502); assert.equal(e.code, 'Invalid response from origin');
    assert.equal(calls, 2, 'retried once');

    e = await err({ timeoutMs: 50, fetch: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
    assert.equal(e.status, 504); assert.equal(e.code, 'Origin timeout');

    e = await err({ fetch: memoryFetch(file, { ignoreRange: true }) });
    assert.equal(e.status, 502, 'origin ignoring Range on a big file');

    // File replaced mid-session: segment reads see a different ETag than init.
    let n = 0;
    const flapping = (u, i) => memoryFetch(file, { etag: n++ === 0 ? '"a"' : '"b"' })(u, i);
    const s3 = await RemoteMp4.fromUrl('mem://x.mp4', { segmentDuration: 4, fetch: flapping });
    e = await s3.getSegment(0).then(() => null, x => x);
    assert.equal(e?.code, 'Flapping origin entity');
  });
});

// ---------------------------------------------------------------------------
// clipMp4: source edit lists + audio preroll (A/V sync)
// ---------------------------------------------------------------------------

/**
 * Per-track timestamp shift between source and clip, matching packets by size
 * (a remux keeps payloads identical). Equal shifts on both tracks = sync kept.
 */
function trackShift(srcPath, outPath, sel) {
  const pk = (p) => probeJson(p, ['-select_streams', sel, '-show_packets', '-show_entries', 'packet=pts_time,size'])
    .packets.map(x => [Number(x.pts_time), Number(x.size)]);
  const src = pk(srcPath), out = pk(outPath);
  const n = Math.min(20, out.length);
  for (let k = 0; k + n <= src.length; k++) {
    if (out.slice(0, n).every((o, i) => o[1] === src[k + i][1])) {
      return out.map((o, i) => o[0] - src[k + i][0]).reduce((a, b) => a + b, 0) / out.length;
    }
  }
  throw new Error(`no packet alignment for ${sel}`);
}

test('clipMp4 keeps A/V sync with source edit lists (B-frames + AAC priming)', { skip: !ffmpegOk && 'ffmpeg/ffprobe not installed' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tomp4-clipsync-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, 'src.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '10', '-c:v', 'libx264', '-bf', '2', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', src]);
  const data = new Uint8Array(readFileSync(src));

  // start on a keyframe, between keyframes, inside a frame (snaps to 3.3667), near 0
  for (const [start, end, expectStart] of [[2, 6, 2], [2.5, 6, 2.5], [3.37, 7.1, 101 / 30], [0.01, 3, 0]]) {
    const out = join(dir, `clip-${start}.mp4`);
    writeFileSync(out, clipMp4(data, { startTime: start, endTime: end }));
    const v = trackShift(src, out, 'v:0');
    const a = trackShift(src, out, 'a:0');
    assert.ok(Math.abs(v - a) < 0.0005, `clip ${start}s: A/V error ${((v - a) * 1000).toFixed(1)} ms`);
    assert.ok(Math.abs(v + expectStart) < 0.0005, `clip ${start}s: starts at ${(-v).toFixed(4)} s, expected ${expectStart.toFixed(4)}`);
  }
});
