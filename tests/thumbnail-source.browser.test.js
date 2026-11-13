/**
 * Source handlers on a real canvas (browser-only).
 *
 * tests/thumbnail-source.test.js checks the routing against a stand-in canvas.
 * This one registers a handler in headless Chromium and checks the pictures
 * that come out of thumbnail() / thumbnails(): size, encoding and pixels, for
 * each kind of image a handler may hand over (canvas, ImageBitmap, ImageData).
 *
 * Like thumbnail-cmaf, it is NOT in the default `npm test` chain (that stays
 * node-only with zero browser deps). Run it explicitly:
 * `npm run test:thumbnail-source-browser`. If puppeteer isn't installed it
 * SKIPS (exit 0) rather than failing.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = normalize(join(dirname(fileURLToPath(import.meta.url)), '..', 'src'));

let puppeteer;
try {
  puppeteer = (await import('puppeteer')).default;
} catch {
  console.log('⏭  SKIP thumbnail-source: puppeteer not installed (browser-only test)');
  process.exit(0);
}

// --- static server: an empty page + the repo src (for ESM import) ---
const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/runner.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html><body>runner</body></html>');
    return;
  }
  const filePath = normalize(join(SRC, urlPath.replace(/^\/src\//, '')));
  if (!urlPath.startsWith('/src/') || !filePath.startsWith(SRC)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--mute-audio'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(`${base}/runner.html`);

  const out = await page.evaluate(async () => {
    const toMp4 = (await import('/src/index.js')).default;

    // The picture: 640x360, left half red, right half blue.
    const card = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f00';
      ctx.fillRect(0, 0, 320, 360);
      ctx.fillStyle = '#00f';
      ctx.fillRect(320, 0, 320, 360);
      return canvas;
    };
    const kinds = {
      canvas: () => card(),
      bitmap: () => createImageBitmap(card()),
      imageData: () => card().getContext('2d').getImageData(0, 0, 640, 360),
    };

    let closed = 0;
    const unregister = toMp4.registerSource({
      name: 'card',
      test: (input) => !!input?.card,
      async frame(input, { time }) {
        if (time === 2) throw new Error('nothing at 2');
        const image = await kinds[input.card]();
        return { image, close: () => { closed++; image.close?.(); } };
      },
    });

    // Decode an ImageResult back to its size and one pixel from each half.
    const read = async (result) => {
      const bmp = await createImageBitmap(result.toBlob());
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const pixel = (x) => [...ctx.getImageData(x, bmp.height >> 1, 1, 1).data.slice(0, 3)];
      return {
        width: bmp.width,
        height: bmp.height,
        type: result.toBlob().type,
        left: pixel(bmp.width >> 2),
        right: pixel((3 * bmp.width) >> 2),
      };
    };

    const single = {};
    for (const kind of Object.keys(kinds)) {
      single[kind] = await read(await toMp4.thumbnail({ card: kind }, { maxWidth: 160, mimeType: 'image/png' }));
    }

    const seen = [];
    const batch = await toMp4.thumbnails({ card: 'bitmap' }, {
      times: [1, 2, 3], maxWidth: 80, onThumbnail: (time) => seen.push(time),
    });

    unregister();
    return { single, keys: [...batch.keys()], seen, first: await read(batch.get(1)), closed };
  });

  for (const [kind, image] of Object.entries(out.single)) {
    assert.deepEqual(image, { width: 160, height: 90, type: 'image/png', left: [255, 0, 0], right: [0, 0, 255] }, kind);
    console.log(`  ✅ thumbnail() from ${kind}: 160x90 png, pixels intact`);
  }

  assert.deepEqual(out.keys, [1, 3], 'the failing time is left out of the Map');
  assert.deepEqual(out.seen, [1, 3]);
  const { left, right, ...shape } = out.first;
  assert.deepEqual(shape, { width: 80, height: 45, type: 'image/jpeg' });
  assert.ok(left[0] > 200 && left[2] < 60, `left half should be red, got ${left}`);
  assert.ok(right[2] > 200 && right[0] < 60, `right half should be blue, got ${right}`);
  console.log('  ✅ thumbnails(): 80x45 jpeg for times 1 and 3, failing time 2 left out');

  assert.equal(out.closed, 5, 'close() once per picture drawn');
  console.log('\n✅ Source handler thumbnails on a real canvas');
} finally {
  await browser.close();
  server.close();
}
