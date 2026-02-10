import toMp4, { thumbnail } from '../src/index.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function assertRejects(promise, messageIncludes) {
  try {
    await promise;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(
      msg.toLowerCase().includes(messageIncludes.toLowerCase()),
      `Expected error message to include "${messageIncludes}", got: ${msg}`,
    );
    return;
  }
  throw new Error('Expected promise to reject, but it resolved.');
}

// Thumbnail extraction requires DOM APIs. This test ensures we fail fast in Node.
assert(typeof toMp4.thumbnail === 'function', 'Expected toMp4.thumbnail to be a function');
assert(typeof thumbnail === 'function', 'Expected named export `thumbnail` to be a function');

await assertRejects(thumbnail('https://example.com/master.m3u8'), 'browser-only');
await assertRejects(toMp4.thumbnail('https://example.com/master.m3u8'), 'browser-only');

