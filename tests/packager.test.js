/**
 * Packager server (packager/app.js) against a local Range-capable origin.
 *
 * Covers the OTFP-compatible routes, our `-tm` names, refusing OTFP segment
 * names, OTFP-style errors (X-Packager-Error), cache headers, the base URL for
 * absolute variant URLs, one init per source under concurrent requests, the
 * negative cache for missing files, and re-reading a replaced file.
 *
 * Needs ffmpeg to generate the source MP4s (skipped otherwise).
 * Run: node tests/packager.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPackager } from '../packager/app.js';

let ffmpegOk = false;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ffmpegOk = true; } catch {}

function encode(path, { height, seconds = 8 }) {
  execFileSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${Math.round(height * 16 / 9 / 2) * 2}x${height}:rate=30`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(seconds), '-c:v', 'libx264', '-bf', '2', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', path]);
  return new Uint8Array(readFileSync(path));
}

/** Origin serving `files` (path → bytes) with Range, ETag, and a request log. */
async function startOrigin(files) {
  const log = [];
  const server = http.createServer((req, res) => {
    log.push({ path: req.url, range: req.headers.range });
    const body = files.get(req.url);
    if (!body) { res.writeHead(404); res.end(); return; }
    const etag = `"${body.length}-${body[body.length - 1]}"`;
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (!m) { res.writeHead(200, { 'Content-Length': body.length, ETag: etag }); res.end(Buffer.from(body)); return; }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), body.length - 1);
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1, ETag: etag });
    res.end(Buffer.from(body.subarray(start, end + 1)));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, log, close: () => new Promise(r => server.close(r)) };
}

async function startPackager(config) {
  const logs = [];
  const { handler, cache } = createPackager({ ...config, log: (e) => logs.push(e) });
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, cache, logs, close: () => new Promise(r => server.close(r)) };
}

test('packager', { skip: !ffmpegOk && 'ffmpeg not installed' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tomp4-packager-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const files = new Map([
    ['/media/123/abc.mp4', encode(join(dir, 'a.mp4'), { height: 360 })],
    ['/media/123/abc_160p_30fps.mp4', encode(join(dir, 'b.mp4'), { height: 160 })],
  ]);
  const origin = await startOrigin(files);
  const pk = await startPackager({ originBase: `${origin.url}/media/`, segmentDuration: 4 });
  t.after(async () => { await pk.close(); await origin.close(); });

  const get = (path, headers = {}) => fetch(`${pk.base}${path}`, { headers });

  await t.test('master: comma list → variants in order, absolute -tm URLs from X-Packager-Base-Url', async () => {
    const res = await get('/123/abc,abc_160p_30fps/master.m3u8', { 'X-Packager-Base-Url': 'https://svod.example.com/' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.apple.mpegurl');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('x-packager'), 'tomp4');
    const body = await res.text();
    const uris = body.split('\n').filter(l => l.startsWith('https://'));
    assert.deepEqual(uris, [
      'https://svod.example.com/123/abc-tm.m3u8',
      'https://svod.example.com/123/abc_160p_30fps-tm.m3u8',
    ]);
    assert.match(body, /RESOLUTION=640x360/);
    assert.match(body, /RESOLUTION=284x160/);
    assert.match(body, /CODECS="avc1\.[0-9a-f]{6},mp4a\.40\.2"/);
  });

  await t.test('master: base URL falls back to the request host; start/end carried to variants', async () => {
    const body = await (await get('/123/abc/master.m3u8?start=2&end=6')).text();
    assert.match(body, new RegExp(`^${pk.base}/123/abc-tm\\.m3u8\\?start=2&end=6$`, 'm'));
  });

  await t.test('media playlist on the OTFP path and on the -tm path: relative -tm segment names', async () => {
    for (const path of ['/123/abc.m3u8', '/123/abc-tm.m3u8']) {
      const body = await (await get(path)).text();
      assert.match(body, /^abc-tm1\.ts$/m, path);
      assert.match(body, /^abc-tm2\.ts$/m, path);
      assert.match(body, /#EXT-X-ENDLIST/);
    }
  });

  await t.test('segment: MPEG-TS, immutable caching, ETag revalidation', async () => {
    const res = await get('/123/abc-tm1.ts');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'video/mp2t');
    assert.match(res.headers.get('cache-control'), /immutable/);
    const ts = new Uint8Array(await res.arrayBuffer());
    assert.equal(ts[0], 0x47);
    assert.equal(ts.length % 188, 0);
    const again = await get('/123/abc-tm1.ts', { 'If-None-Match': res.headers.get('etag') });
    assert.equal(again.status, 304);
  });

  await t.test('HEAD returns headers without a body', async () => {
    const res = await fetch(`${pk.base}/123/abc-tm1.ts`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.ok(Number(res.headers.get('content-length')) > 0);
    assert.equal((await res.arrayBuffer()).byteLength, 0);
  });

  await t.test('errors carry X-Packager-Error, mirroring OTFP', async () => {
    const expect = async (path, status, code) => {
      const res = await get(path);
      assert.equal(res.status, status, path);
      assert.equal(res.headers.get('x-packager-error'), code, path);
      assert.equal(res.headers.get('x-packager'), 'tomp4', `${path}: errors identify the packager too`);
    };
    await expect('/123/missing.m3u8', 404, 'Origin 404');
    await expect('/123/abc-1.ts', 404, 'Foreign segment name');
    await expect('/123/abc-tm999.ts', 404, 'Segment not found');
    await expect('/123/abc.webvtt.m3u8', 404, 'Subtitles not supported');
    await expect('/123/abc.m3u8?start=5&end=2', 400, 'Invalid request');
    await expect('/123/a,b,c,d,e,f,g,h,i,j,k/master.m3u8', 400, 'Invalid request');
    const res = await fetch(`${pk.base}/123/abc.m3u8`, { method: 'POST' });
    assert.equal(res.status, 405);
  });

  await t.test('path traversal is rejected', async () => {
    const res = await get('/123/..%2F..%2Fsecret.m3u8');
    assert.ok(res.status === 400 || res.status === 404);
    assert.ok(!origin.log.some(r => r.path.includes('secret')), 'never reaches the origin');
  });

  await t.test('healthz', async () => {
    const res = await get('/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await res.json()).ok, true);
  });

  await t.test('concurrent cold requests share one origin init per source', async () => {
    const pk2 = await startPackager({ originBase: `${origin.url}/media/`, segmentDuration: 4 });
    t.after(() => pk2.close());
    const before = origin.log.length;
    await Promise.all(Array.from({ length: 8 }, () => fetch(`${pk2.base}/123/abc_160p_30fps.m3u8`).then(r => r.text())));
    const inits = origin.log.slice(before).filter(r => r.path === '/media/123/abc_160p_30fps.mp4');
    assert.equal(inits.length, 1, 'one probe read (the small file fits in it)');
    assert.equal(pk2.cache.snapshot().misses, 1);
  });

  await t.test('missing files are negatively cached briefly', async () => {
    const before = origin.log.length;
    await get('/123/nothing-here.m3u8');
    await get('/123/nothing-here.m3u8');
    assert.equal(origin.log.slice(before).filter(r => r.path.includes('nothing-here')).length, 1);
  });

  await t.test('a replaced origin file is re-read after the ETag changes', async () => {
    await (await get('/123/abc-tm1.ts')).arrayBuffer();               // cached source, ETag A
    files.set('/media/123/abc.mp4', encode(join(dir, 'c.mp4'), { height: 360, seconds: 10 })); // ETag B
    const flap = await get('/123/abc-tm2.ts');
    assert.equal(flap.status, 500);
    assert.equal(flap.headers.get('x-packager-error'), 'Flapping origin entity');
    const after = await (await get('/123/abc.m3u8')).text();          // re-read: 10 s file now (8 s had 2)
    assert.equal(after.match(/#EXTINF/g).length, 3);
  });

  await t.test('every request is logged as one JSON line', () => {
    assert.ok(pk.logs.length > 10);
    for (const e of pk.logs) assert.ok(e.method && e.path && Number.isInteger(e.status));
  });
});
