/**
 * Source handlers: toMp4.registerSource() lets the host supply the pictures
 * for thumbnail() / thumbnails() when the input is one the library cannot
 * decode itself.
 *
 * The canvas is browser-only, so this runs the routing against a minimal
 * stand-in for document/canvas. The real canvas path is covered by
 * tests/thumbnail-source.browser.test.js.
 *
 * Run: node tests/thumbnail-source.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import toMp4, { registerSource, thumbnail, thumbnails, ImageResult } from '../src/index.js';

const picture = { width: 640, height: 360 };

// A handler for inputs shaped { card: ... } that hands back a fixed picture.
function cardSource(overrides = {}) {
  const source = {
    name: 'card',
    calls: [],
    closed: 0,
    test: (input) => !!input?.card,
    async frame(input, request) {
      source.calls.push({ input, ...request });
      return { image: picture, close: () => { source.closed++; } };
    },
    ...overrides,
  };
  return source;
}

// Registers for the length of one test, so no handler leaks into the next.
function register(t, source) {
  const unregister = registerSource(source);
  t.after(unregister);
  return unregister;
}

const canvases = [];
function installDom() {
  globalThis.window = globalThis;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas', 'a handler input must not reach the <video> path');
      const canvas = {
        width: 0,
        height: 0,
        drawn: [],
        getContext: () => ({
          drawImage: (...args) => canvas.drawn.push(args),
          putImageData: (data) => { canvas.put = data; },
        }),
        toBlob(done, type, quality) {
          canvas.encoded = { type, quality };
          done(new Blob(['image'], { type }));
        },
      };
      canvases.push(canvas);
      return canvas;
    },
  };
}

test('registerSource is exported and validates the handler', () => {
  assert.equal(toMp4.registerSource, registerSource);
  assert.throws(() => registerSource(), TypeError);
  assert.throws(() => registerSource({ name: 'x', test: () => true }), TypeError);
  assert.throws(() => registerSource({ name: 'x', frame: async () => ({}) }), TypeError);
});

test('without a DOM the call is browser-only, handler or not', async (t) => {
  const source = cardSource();
  register(t, source);
  await assert.rejects(thumbnail({ card: 1 }), /browser-only/);
  await assert.rejects(thumbnail('https://example.com/master.m3u8'), /browser-only/);
  await assert.rejects(thumbnails({ card: 1 }, { times: [1] }), /browser-only/);
  assert.equal(source.calls.length, 0);
});

test('with a DOM', async (t) => {
  installDom();
  t.after(() => { delete globalThis.document; delete globalThis.window; });

  await t.test('thumbnail() routes to the handler and scales/encodes like the built-in path', async (t) => {
    const source = cardSource();
    register(t, source);
    const input = { card: 1 };
    canvases.length = 0;

    const image = await toMp4.thumbnail(input, { time: 12.5, maxWidth: 160, mimeType: 'image/png', quality: 0.5 });

    assert.deepEqual(source.calls, [{ input, time: 12.5, signal: undefined }]);
    assert.ok(image instanceof ImageResult);
    assert.equal(image.toBlob().type, 'image/png');
    assert.equal(image.filename, 'thumbnail.png');
    assert.equal(image.time, 12.5, 'time defaults to the time asked for');
    assert.equal(canvases.length, 1);
    assert.deepEqual([canvases[0].width, canvases[0].height], [160, 90]);
    assert.deepEqual(canvases[0].drawn, [[picture, 0, 0, 160, 90]]);
    assert.deepEqual(canvases[0].encoded, { type: 'image/png', quality: 0.5 });
    assert.equal(source.closed, 1, 'close() is called once the image is drawn');
  });

  await t.test('thumbnail() defaults: time 0, 480 wide, never upscaled, jpeg', async (t) => {
    const source = cardSource({
      async frame(input, request) {
        source.calls.push(request);
        return { image: { width: 320, height: 200 }, time: 0.04 };
      },
    });
    register(t, source);
    canvases.length = 0;

    const image = await thumbnail({ card: 1 });

    assert.equal(source.calls[0].time, 0);
    assert.deepEqual([canvases[0].width, canvases[0].height], [320, 200]);
    assert.deepEqual(canvases[0].encoded, { type: 'image/jpeg', quality: 0.82 });
    assert.equal(image.time, 0.04, 'the time the handler reports is kept');
  });

  await t.test('an ImageData is put on a canvas of its own size, then scaled', async (t) => {
    globalThis.ImageData = class ImageData {
      constructor(width, height) { this.width = width; this.height = height; }
    };
    t.after(() => { delete globalThis.ImageData; });
    const data = new ImageData(640, 360);
    register(t, cardSource({ frame: async () => ({ image: data }) }));
    canvases.length = 0;

    await thumbnail({ card: 1 }, { maxWidth: 320 });

    const [full, scaled] = canvases;
    assert.deepEqual([full.width, full.height, full.put], [640, 360, data]);
    assert.deepEqual(scaled.drawn, [[full, 0, 0, 320, 180]]);
  });

  await t.test('the first registered handler whose test() is true wins', async (t) => {
    const never = cardSource({ name: 'never', test: () => false });
    const first = cardSource({ name: 'first' });
    const second = cardSource({ name: 'second' });
    for (const source of [never, first, second]) register(t, source);

    await thumbnail({ card: 1 });
    await thumbnails({ card: 1 }, { times: [1, 2] });

    assert.deepEqual([never.calls.length, first.calls.length, second.calls.length], [0, 3, 0]);
  });

  await t.test('unregister removes the handler; an input no handler takes goes the built-in way', async (t) => {
    const source = cardSource({ test: (input) => !!input?.card || Array.isArray(input?.segments) });
    const unregister = register(t, source);
    // Reaches the built-in detection, which rejects fragments without an init segment.
    const fragments = { segments: [new Uint8Array(8)] };

    await thumbnail(fragments);
    assert.equal(source.calls.length, 1);

    unregister();
    unregister(); // harmless twice
    await assert.rejects(thumbnail(fragments), /requires an init segment/);
    assert.equal(source.calls.length, 1);

    const other = cardSource();
    register(t, other);
    await assert.rejects(thumbnail(fragments), /requires an init segment/);
    // thumbnails() goes on to fetch the playlist.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404, statusText: 'Not Found' });
    t.after(() => { globalThis.fetch = realFetch; });
    await assert.rejects(thumbnails('https://example.com/master.m3u8', { times: [1] }), /Failed to fetch playlist: 404/);
    assert.equal(other.calls.length, 0);
  });

  await t.test('a failing handler rejects with its name and does not break later calls', async (t) => {
    let mode = 'frame-rejects';
    const source = cardSource({
      name: 'flaky',
      test(input) {
        if (mode === 'test-throws') throw new Error('bad input');
        return !!input?.card;
      },
      async frame() {
        if (mode === 'frame-rejects') throw new Error('no picture');
        if (mode === 'no-image') return {};
        return { image: picture };
      },
    });
    register(t, source);

    await assert.rejects(thumbnail({ card: 1 }, { time: 3 }), (err) => {
      assert.equal(err.message, 'Source handler "flaky" failed at 3s: no picture');
      assert.equal(err.cause.message, 'no picture');
      return true;
    });
    mode = 'no-image';
    await assert.rejects(thumbnail({ card: 1 }), /Source handler "flaky" failed at 0s: frame\(\) returned no image/);
    mode = 'test-throws';
    await assert.rejects(thumbnail({ card: 1 }), /Source handler "flaky" test\(\) threw: bad input/);
    await assert.rejects(thumbnails({ card: 1 }, { times: [1] }), /Source handler "flaky" test\(\) threw: bad input/);
    mode = 'ok';
    assert.ok(await thumbnail({ card: 1 }) instanceof ImageResult);
  });

  await t.test('close() is called even when the image cannot be drawn', async (t) => {
    const source = cardSource({
      frame: async () => ({ image: { width: 0, height: 0 }, close: () => { source.closed++; } }),
    });
    register(t, source);
    await assert.rejects(thumbnail({ card: 1 }), /Source handler "card" failed at 0s: No video frame available/);
    assert.equal(source.closed, 1);
  });

  await t.test('thumbnails(): one frame() per time, keyed by the requested time, within concurrency', async (t) => {
    let running = 0;
    let peak = 0;
    const source = cardSource({
      async frame(input, request) {
        source.calls.push(request);
        peak = Math.max(peak, ++running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        return { image: picture, time: request.time + 0.01, close: () => { source.closed++; } };
      },
    });
    register(t, source);
    const times = [8, 1, 5, 3, 2, 13, 21];
    const seen = [];
    canvases.length = 0;

    const images = await toMp4.thumbnails({ card: 1 }, {
      times, concurrency: 3, maxWidth: 64, mimeType: 'image/webp', quality: 0.4,
      onThumbnail: (time, image) => seen.push([time, image]),
    });

    assert.deepEqual([...images.keys()].sort((a, b) => a - b), [...times].sort((a, b) => a - b));
    assert.deepEqual(source.calls.map((c) => c.time), times, 'times are asked for in the order given');
    assert.equal(peak, 3);
    assert.equal(source.closed, times.length);
    assert.equal(seen.length, times.length);
    for (const [time, image] of seen) assert.equal(images.get(time), image);
    assert.equal(images.get(13).time, 13.01);
    assert.deepEqual([canvases[0].width, canvases[0].height], [64, 36]);
    assert.deepEqual(canvases[0].encoded, { type: 'image/webp', quality: 0.4 });
  });

  await t.test('thumbnails(): a failing time is left out and does not fail the others', async (t) => {
    const source = cardSource({
      async frame(input, { time }) {
        if (time === 2 || time === 4) throw new Error(`nothing at ${time}`);
        return { image: picture };
      },
    });
    register(t, source);
    const seen = [];

    const images = await thumbnails({ card: 1 }, {
      times: [1, 2, 3, 4, 5], concurrency: 2, onThumbnail: (time) => seen.push(time),
    });

    assert.deepEqual([...images.keys()], [1, 3, 5]);
    assert.deepEqual(seen, [1, 3, 5]);

    // Only when every time failed does the call reject, with the first failure.
    await assert.rejects(
      thumbnails({ card: 1 }, { times: [2, 4] }),
      /Source handler "card" failed at 2s: nothing at 2/,
    );
  });

  await t.test('timeoutMs applies, and a timed-out batch asks for no more frames', async (t) => {
    const pending = [];
    const source = cardSource({
      frame(input, request) {
        source.calls.push(request);
        return new Promise((resolve) => pending.push(resolve));
      },
    });
    register(t, source);

    await assert.rejects(thumbnail({ card: 1 }, { timeoutMs: 10 }), /Thumbnail generation timed out/);
    source.calls.length = 0;
    await assert.rejects(
      thumbnails({ card: 1 }, { times: [1, 2, 3, 4, 5, 6], concurrency: 2, timeoutMs: 10 }),
      /Batch thumbnail generation timed out/,
    );
    for (const resolve of pending) resolve({ image: picture });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(source.calls.length, 2);
  });
});
