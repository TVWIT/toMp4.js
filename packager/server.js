#!/usr/bin/env node
/**
 * OTFP-compatible HLS packager server. Configuration via environment:
 *
 *   PORT                     8080
 *   HOST                     0.0.0.0
 *   ORIGIN_BASE              https://s3.us-east-005.backblazeb2.com/invintus-client-media/
 *   PUBLIC_BASE_URL          (optional) base for absolute variant URLs when the
 *                            request has no X-Packager-Base-Url header
 *   SEGMENT_DURATION         6      seconds, keyframe-aligned
 *   ORIGIN_TIMEOUT_MS        15000
 *   CACHE_MAX_MB             512    parsed-source cache budget
 *   CACHE_TTL_S              21600
 *   MAX_CONCURRENT_SEGMENTS  32
 */

import http from 'node:http';
import { createPackager } from './app.js';

const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

const config = {
  originBase: env.ORIGIN_BASE || 'https://s3.us-east-005.backblazeb2.com/invintus-client-media/',
  publicBaseUrl: env.PUBLIC_BASE_URL || undefined,
  segmentDuration: num(env.SEGMENT_DURATION, 6),
  originTimeoutMs: num(env.ORIGIN_TIMEOUT_MS, 15000),
  cacheMaxBytes: num(env.CACHE_MAX_MB, 512) * 1024 * 1024,
  cacheTtlMs: num(env.CACHE_TTL_S, 21600) * 1000,
  maxConcurrentSegments: num(env.MAX_CONCURRENT_SEGMENTS, 32),
};

const { handler } = createPackager(config);
const server = http.createServer(handler);
server.keepAliveTimeout = 65_000; // longer than typical CDN idle timeouts
server.headersTimeout = 66_000;

const port = num(env.PORT, 8080);
server.listen(port, env.HOST || '0.0.0.0', () => {
  process.stdout.write(`${JSON.stringify({ level: 'info', msg: 'packager listening', port, originBase: config.originBase })}\n`);
});

function shutdown(signal) {
  process.stdout.write(`${JSON.stringify({ level: 'info', msg: `${signal}: draining` })}\n`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
