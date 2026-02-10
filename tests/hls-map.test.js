/**
 * HLS EXT-X-MAP init segment support test
 *
 * This test does NOT hit the network. It mocks fetch() and serves:
 * - a master playlist
 * - a media playlist with #EXT-X-MAP
 * - init + segment bytes from tests/fmp4-samples/
 *
 * Run: node tests/hls-map.test.js
 */

import toMp4 from '../src/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let passed = 0;
let failed = 0;

function test(name, fn) {
  return { name, fn };
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function makeResponse(body, { status = 200, headers = {} } = {}) {
  const isString = typeof body === 'string';
  const bytes = isString ? null : body;
  const text = isString ? body : null;

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Map(Object.entries(headers)),
    async text() {
      if (text != null) return text;
      return Buffer.from(bytes).toString('utf8');
    },
    async arrayBuffer() {
      if (bytes == null) return Buffer.from(text || '').buffer;
      // Return a detached-ish ArrayBuffer slice
      const b = Buffer.from(bytes);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  };
}

async function runTests(tests) {
  console.log('\n═'.repeat(60));
  console.log('   HLS EXT-X-MAP Tests');
  console.log('═'.repeat(60) + '\n');

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (err) {
      console.log(`❌ ${name}`);
      console.log(`   Error: ${err.message}`);
      failed++;
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(60) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const samplesDir = path.join(__dirname, 'fmp4-samples');

const INIT_FILE = path.join(samplesDir, 'init_0.m4s');
const SEG1_FILE = path.join(samplesDir, 'segment_0_1.m4s');
const SEG2_FILE = path.join(samplesDir, 'segment_0_2.m4s');

const initBytes = new Uint8Array(readFileSync(INIT_FILE));
const seg1Bytes = new Uint8Array(readFileSync(SEG1_FILE));
const seg2Bytes = new Uint8Array(readFileSync(SEG2_FILE));

const MASTER_URL = 'https://example.test/master.m3u8';
const MEDIA_URL = 'https://example.test/media.m3u8';
const INIT_URL = 'https://example.test/init_0.m4s';
const SEG1_URL = 'https://example.test/segment_0_1.m4s';
const SEG2_URL = 'https://example.test/segment_0_2.m4s';

const masterPlaylist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
media.m3u8
`;

const mediaPlaylist = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:7
#EXT-X-MAP:URI="init_0.m4s"
#EXTINF:6.006,
segment_0_1.m4s
#EXTINF:6.006,
segment_0_2.m4s
#EXT-X-ENDLIST
`;

const tests = [
  test('parseHls captures initSegmentUrl from EXT-X-MAP', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url === MEDIA_URL) return makeResponse(mediaPlaylist);
      throw new Error(`Unexpected fetch: ${url}`);
    };
    try {
      const hls = await toMp4.parseHls(MEDIA_URL);
      assert(hls.segments && hls.segments.length === 2, 'Should parse segments');
      assert(hls.initSegmentUrl === INIT_URL, 'Should capture initSegmentUrl');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }),

  test('downloadHls prepends init segment so toMp4() can convert', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url === MASTER_URL) return makeResponse(masterPlaylist);
      if (url === MEDIA_URL) return makeResponse(mediaPlaylist);
      if (url === INIT_URL) return makeResponse(initBytes);
      if (url === SEG1_URL) return makeResponse(seg1Bytes);
      if (url === SEG2_URL) return makeResponse(seg2Bytes);
      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const combined = await toMp4.downloadHls(MASTER_URL, {
        quality: 'highest',
        maxSegments: 2,
        onProgress: () => {},
      });

      // Should begin with ftyp from init segment
      const head = Buffer.from(combined.slice(0, 16));
      assert(head.includes(Buffer.from('ftyp')), 'Combined should include ftyp');

      // Should successfully convert to a standard MP4 (moov, no moof)
      const mp4 = await toMp4(combined, { onProgress: () => {} });
      assert(mp4.data instanceof Uint8Array, 'Should produce Uint8Array mp4');
      assert(mp4.data.length > 0, 'Should produce non-empty output');
      const outHead = Buffer.from(mp4.data.slice(0, 16));
      assert(outHead.includes(Buffer.from('ftyp')), 'Output should include ftyp');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }),
];

runTests(tests);

