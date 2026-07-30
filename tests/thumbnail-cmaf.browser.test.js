/**
 * Regression test for CMAF/fMP4 filmstrip thumbnails (browser-only).
 *
 * The batch `thumbnails()` regular path used to run every segment through the
 * MPEG-TS parser. For fMP4/CMAF archives (`.m4s` fragments + EXT-X-MAP init)
 * that yields no decodable samples, so every frame came out PURE BLACK. The fix
 * gives the batch worker an fMP4 branch that stitches the EXT-X-MAP init onto
 * each fragment (like the single-frame path already did).
 *
 * This test assembles a real CMAF HLS tree from tests/fmp4-samples, serves it,
 * runs thumbnails() in headless Chromium, and asserts the frames are NOT black.
 *
 * It is intentionally NOT in the default `npm test` chain (that stays node-only
 * with zero browser deps). Run it explicitly: `npm run test:thumbnail-cmaf`.
 * If puppeteer isn't installed it SKIPS (exit 0) rather than failing.
 */
import http from 'node:http';
import { readFile, mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const SAMPLES = join(REPO, 'tests', 'fmp4-samples');

let puppeteer;
try {
  puppeteer = (await import('puppeteer')).default;
} catch {
  console.log('⏭  SKIP thumbnail-cmaf: puppeteer not installed (browser-only test)');
  process.exit(0);
}

// --- assemble a CMAF HLS fixture from the committed fMP4 samples ---
const fixtureRoot = await mkdtemp(join(tmpdir(), 'tomp4-cmaf-'));
const vDir = join(fixtureRoot, 'v');
await mkdir(vDir, { recursive: true });
await copyFile(join(SAMPLES, 'init_0.m4s'), join(vDir, 'init.m4s'));
const segs = ['segment_0_1.m4s', 'segment_0_2.m4s', 'segment_0_3.m4s', 'segment_0_4.m4s'];
for (let i = 0; i < segs.length; i++) {
  await copyFile(join(SAMPLES, segs[i]), join(vDir, `seg${i + 1}.m4s`));
}
await writeFile(join(fixtureRoot, 'master.m3u8'),
  '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.64001E",RESOLUTION=1280x720\nv/playlist.m3u8\n');
await writeFile(join(vDir, 'playlist.m3u8'),
  '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.m4s"\n' +
  segs.map((_, i) => `#EXTINF:6.000,\nseg${i + 1}.m4s`).join('\n') + '\n#EXT-X-ENDLIST\n');
await writeFile(join(fixtureRoot, 'runner.html'), '<!doctype html><html><body>runner</body></html>');

// --- static server: serves the repo src (for ESM import) + the fixture ---
const TYPES = {
  '.js': 'text/javascript', '.html': 'text/html', '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4s': 'video/mp4', '.mp4': 'video/mp4',
};
const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  // /fixture/* → the temp fixture; everything else → the repo (for /src/*.js)
  const filePath = urlPath.startsWith('/fixture/')
    ? normalize(join(fixtureRoot, urlPath.slice('/fixture/'.length)))
    : normalize(join(REPO, urlPath));
  const rootOk = filePath.startsWith(fixtureRoot) || filePath.startsWith(REPO);
  if (!rootOk) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

function assert(cond, msg) { if (!cond) throw new Error(msg); }

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(`${base}/fixture/runner.html`);

  const times = [1, 7, 13, 19];
  const stats = await page.evaluate(async (base, times) => {
    const toMp4 = (await import('/src/index.js')).default;
    const imgs = await toMp4.thumbnails(`${base}/fixture/master.m3u8`, { times, maxWidth: 120, hlsQuality: 'lowest' });
    const out = [];
    for (const t of times) {
      const image = imgs.get(t);
      if (!image) { out.push({ t, present: false }); continue; }
      const bmp = await createImageBitmap(image.toBlob());
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let sum = 0, sumSq = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        sum += luma; sumSq += luma * luma; n++;
      }
      const mean = sum / n;
      out.push({ t, present: true, mean, variance: sumSq / n - mean * mean });
    }
    return out;
  }, base, times);

  for (const s of stats) {
    assert(s.present, `thumbnail at t=${s.t}s missing`);
    // A black frame is mean≈0 / variance≈0; real content is far above this.
    const black = s.variance < 5 && s.mean < 8;
    assert(!black, `thumbnail at t=${s.t}s is BLACK (mean=${s.mean.toFixed(2)}, variance=${s.variance.toFixed(2)}) — fMP4 batch path regressed`);
    console.log(`  ✅ t=${s.t}s non-black (mean=${s.mean.toFixed(1)}, variance=${s.variance.toFixed(0)})`);
  }
  console.log(`\n✅ CMAF filmstrip thumbnails: ${stats.length} frames, all non-black`);
} finally {
  await browser.close();
  server.close();
  await rm(fixtureRoot, { recursive: true, force: true });
}
