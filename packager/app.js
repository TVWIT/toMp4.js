/**
 * OTFP-compatible HLS packager: request routing and responses.
 *
 * Accepts the URLs Invintus sends Fastly's On-the-Fly Packager (see
 * docs/plans/2026-10-26-otfp-compatible-packager.md):
 *
 *   GET /{dir}/{a},{b},…/master.m3u8   master; variants are absolute {base}/{dir}/{x}-tm.m3u8
 *   GET /{dir}/{name}.m3u8             media playlist of {origin}/{dir}/{name}.mp4
 *   GET /{dir}/{name}-tm.m3u8          same (the variant URLs this packager emits)
 *   GET /{dir}/{name}-tm{n}.ts         MPEG-TS segment n (1-based)
 *   GET /healthz                       liveness (for the Fastly health check)
 *
 * `?start=&end=` slices playlists (seconds, segment-level). Segments named the
 * OTFP way (`{name}-{n}.ts`) are refused: their cut points are OTFP's, and
 * mixing packagers within one session can glitch playback.
 */

import { createHash } from 'node:crypto';
import { RemoteMp4 } from '../src/index.js';
import { SourceCache } from './source-cache.js';

const SAFE_PATH = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
const MAX_VARIANTS = 10; // OTFP allows up to 10 comma-separated files

const MIME_M3U8 = 'application/vnd.apple.mpegurl';
const MIME_TS = 'video/mp2t';

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** Minimal counting semaphore for segment builds. */
function semaphore(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active++;
    queue.shift()();
  };
  return async (fn) => {
    await new Promise((resolve) => { queue.push(resolve); next(); });
    try { return await fn(); } finally { active--; next(); }
  };
}

const segmentName = (name) => (i) => `${name}-tm${i + 1}.ts`;

function parseRequest(pathname) {
  if (pathname === '/healthz') return { kind: 'health' };

  let m = /^\/(.+)\/([^/]+)\/master\.m3u8$/.exec(pathname);
  if (m) {
    const [, dir, list] = m;
    const parts = list.split(',').filter(Boolean);
    if (parts.length === 0 || parts.length > MAX_VARIANTS) throw new HttpError(400, 'Invalid request');
    return { kind: 'master', dir, parts };
  }

  if (/\.webvtt\.m3u8$/.test(pathname)) throw new HttpError(404, 'Subtitles not supported');

  m = /^\/(.+)\/([^/]+?)(-tm)?\.m3u8$/.exec(pathname);
  if (m) return { kind: 'media', dir: m[1], name: m[2] };

  m = /^\/(.+)\/([^/]+)-tm(\d+)\.ts$/.exec(pathname);
  if (m) return { kind: 'segment', dir: m[1], name: m[2], number: Number(m[3]) };

  if (/-\d+\.ts$/.test(pathname)) throw new HttpError(404, 'Foreign segment name');
  throw new HttpError(404, 'Not found');
}

function sliceParams(searchParams) {
  const num = (k) => {
    const v = searchParams.get(k);
    if (v === null || v === '') return undefined;
    if (!/^\d+(\.\d+)?$/.test(v)) throw new HttpError(400, 'Invalid request');
    return Number(v);
  };
  const start = num('start');
  const end = num('end');
  if (end !== undefined && end <= (start ?? 0)) throw new HttpError(400, 'Invalid request');
  return { start, end };
}

/**
 * @param {object} config
 * @param {string} config.originBase - e.g. https://s3.us-east-005.backblazeb2.com/invintus-client-media/
 * @param {string} [config.publicBaseUrl] - fallback base for absolute variant URLs
 * @param {number} [config.segmentDuration=6]
 * @param {number} [config.originTimeoutMs=15000]
 * @param {number} [config.cacheMaxBytes=512 MiB]
 * @param {number} [config.cacheTtlMs=6 h]
 * @param {number} [config.maxConcurrentSegments=32]
 * @param {typeof fetch} [config.fetch]
 * @param {(entry: object) => void} [config.log]
 */
export function createPackager(config) {
  const originBase = config.originBase.endsWith('/') ? config.originBase : `${config.originBase}/`;
  const cache = new SourceCache({
    maxBytes: config.cacheMaxBytes ?? 512 * 1024 * 1024,
    ttlMs: config.cacheTtlMs ?? 6 * 3600 * 1000,
    remoteOptions: {
      segmentDuration: config.segmentDuration ?? 6,
      segmentBoundary: 'after', // ffmpeg hls_time cuts, like OTFP
      timeoutMs: config.originTimeoutMs ?? 15000,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    },
  });
  const limit = semaphore(config.maxConcurrentSegments ?? 32);
  const log = config.log ?? ((entry) => process.stdout.write(`${JSON.stringify(entry)}\n`));
  const startedAt = Date.now();

  const originUrl = (dir, name) => {
    const path = `${dir}/${name}`;
    if (!SAFE_PATH.test(path) || path.split('/').includes('..')) throw new HttpError(400, 'Invalid request');
    return `${originBase}${path}.mp4`;
  };

  function baseUrl(req) {
    const header = req.headers['x-packager-base-url'];
    if (header) return String(header).replace(/\/+$/, '');
    if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    return `${proto}://${req.headers.host}`;
  }

  async function withSource(url, fn) {
    const source = await cache.get(url);
    try {
      return await fn(source);
    } catch (err) {
      if (err?.code === 'Flapping origin entity') cache.invalidate(url); // file replaced: re-read next time
      throw err;
    }
  }

  async function route(req, url) {
    const target = parseRequest(url.pathname);

    if (target.kind === 'health') {
      return {
        status: 200,
        type: 'application/json',
        cache: 'no-store',
        body: JSON.stringify({ ok: true, uptimeS: Math.round((Date.now() - startedAt) / 1000), cache: cache.snapshot() }),
      };
    }

    const slice = sliceParams(url.searchParams);

    if (target.kind === 'master') {
      const sources = await Promise.all(target.parts.map((p) => cache.get(originUrl(target.dir, p))));
      const qs = url.search && (slice.start !== undefined || slice.end !== undefined)
        ? `?${new URLSearchParams(Object.entries(slice).filter(([, v]) => v !== undefined)).toString()}`
        : '';
      const base = `${baseUrl(req)}/${target.dir}/`;
      const body = RemoteMp4.buildMasterPlaylist(
        sources.map((source, i) => ({ source, uri: `${base}${target.parts[i]}-tm.m3u8${qs}` })),
      );
      return { status: 200, type: MIME_M3U8, cache: 'public, max-age=3600', body };
    }

    if (target.kind === 'media') {
      const body = await withSource(originUrl(target.dir, target.name), (source) =>
        source.getMediaPlaylist('', { segmentName: segmentName(target.name), ...slice }));
      return { status: 200, type: MIME_M3U8, cache: 'public, max-age=3600', body };
    }

    // segment
    const body = await withSource(originUrl(target.dir, target.name), (source) => {
      const index = target.number - 1;
      if (!source.segments[index]) throw new HttpError(404, 'Segment not found');
      return limit(() => source.getSegment(index));
    });
    // Names are content hashes (asset IDs), so segments never change.
    return { status: 200, type: MIME_TS, cache: 'public, max-age=604800, immutable', body };
  }

  async function handler(req, res) {
    const t0 = performance.now();
    const url = new URL(req.url, 'http://packager.local');
    const common = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Length, X-Packager, X-Packager-Error',
      // Lets the CDN tell our responses (including errors) from OTFP's, so a
      // failed failover isn't retried in a loop.
      'X-Packager': 'tomp4',
    };
    let status = 500;
    let bytes = 0;
    let errorCode;

    try {
      if (req.method === 'OPTIONS') {
        status = 204;
        res.writeHead(204, { ...common, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Range' });
        res.end();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');

      const out = await route(req, url);
      const payload = typeof out.body === 'string' ? Buffer.from(out.body) : Buffer.from(out.body.buffer, out.body.byteOffset, out.body.byteLength);
      const etag = `"${createHash('sha1').update(payload).digest('base64url').slice(0, 27)}"`;
      status = req.headers['if-none-match'] === etag ? 304 : out.status;
      bytes = status === 304 || req.method === 'HEAD' ? 0 : payload.length;
      res.writeHead(status, {
        ...common,
        'Content-Type': out.type,
        'Content-Length': payload.length,
        'Cache-Control': out.cache,
        ETag: etag,
      });
      res.end(bytes ? payload : undefined);
    } catch (err) {
      status = Number.isInteger(err?.status) ? err.status : 500;
      errorCode = err?.code || 'Internal error';
      if (status >= 500 && !err?.status) log({ level: 'error', msg: err?.stack || String(err) });
      const body = `${errorCode}\n`;
      res.writeHead(status, {
        ...common,
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': status === 404 ? 'public, max-age=60' : 'no-store',
        'X-Packager-Error': errorCode,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } finally {
      log({
        t: new Date().toISOString(),
        method: req.method,
        path: url.pathname + url.search,
        status,
        ms: Math.round(performance.now() - t0),
        bytes,
        ...(errorCode ? { err: errorCode } : {}),
      });
    }
  }

  return { handler, cache };
}
