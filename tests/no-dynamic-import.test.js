/**
 * No dynamic import() in src.
 *
 * Bundlers route a dependency's dynamic import() through a preload helper that
 * lives in the host app's entry chunk, so the entry gains an `export`. Hosts
 * that load their entry as a classic script then fail with "Unexpected token
 * 'export'" (hosted-player wraps its entry in an IIFE). Everything in src is
 * reachable from index.js anyway, so static imports cost nothing.
 *
 * Run: node tests/no-dynamic-import.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? jsFiles(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []);
}

test('src has no dynamic import()', () => {
  const found = [];
  for (const file of jsFiles(SRC)) {
    // Drop comments: JSDoc types use import('./x.js') legitimately.
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const line of code.split('\n')) {
      if (/\bimport\s*\(/.test(line)) found.push(`${relative(SRC, file)}: ${line.trim()}`);
    }
  }
  assert.deepEqual(found, [], `use static imports:\n${found.join('\n')}`);
});
