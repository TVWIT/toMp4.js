/**
 * Cache of initialised RemoteMp4 sources.
 *
 * - One init per source at a time: concurrent requests share the pending promise.
 * - LRU, bounded by an estimate of the sample-table memory each source holds.
 * - Entries expire after `ttlMs` so a replaced origin file is eventually re-read
 *   (a mid-session replacement is caught earlier by RemoteMp4's ETag check).
 * - Failed inits aren't cached, except "Origin 404", which is remembered
 *   briefly so a missing file doesn't send every request to the origin.
 */

import { RemoteMp4, RemoteMp4Error } from '../src/index.js';

const NEGATIVE_TTL_MS = 30_000;

/** Rough bytes held by a source: compact sample tables + segment objects. */
function estimateBytes(source) {
  const info = source.getInfo();
  return info.videoSampleCount * 29 + info.audioSampleCount * 20 + info.segmentCount * 160 + 4096;
}

export class SourceCache {
  /**
   * @param {object} opts
   * @param {number} opts.maxBytes
   * @param {number} opts.ttlMs
   * @param {object} opts.remoteOptions - passed to RemoteMp4.fromUrl
   * @param {() => number} [opts.now]
   */
  constructor({ maxBytes, ttlMs, remoteOptions = {}, now = Date.now }) {
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.remoteOptions = remoteOptions;
    this.now = now;
    this.entries = new Map(); // url -> { promise, source, bytes, expires }
    this.missing = new Map(); // url -> expiry (Origin 404)
    this.bytes = 0;
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  /** @returns {Promise<RemoteMp4>} */
  get(url) {
    const now = this.now();
    const miss = this.missing.get(url);
    if (miss && miss > now) return Promise.reject(new RemoteMp4Error('Origin 404', { status: 404, detail: 'cached' }));
    if (miss) this.missing.delete(url);

    const entry = this.entries.get(url);
    if (entry && entry.expires > now) {
      this.stats.hits++;
      // Re-insert to mark as most recently used.
      this.entries.delete(url);
      this.entries.set(url, entry);
      return entry.promise;
    }
    if (entry) this._remove(url);

    this.stats.misses++;
    const fresh = { source: null, bytes: 0, expires: now + this.ttlMs, promise: null };
    fresh.promise = RemoteMp4.fromUrl(url, this.remoteOptions).then(
      (source) => {
        if (this.entries.get(url) === fresh) {
          fresh.source = source;
          fresh.bytes = estimateBytes(source);
          this.bytes += fresh.bytes;
          this._evict();
        }
        return source;
      },
      (err) => {
        if (this.entries.get(url) === fresh) this.entries.delete(url);
        if (err?.code === 'Origin 404') this.missing.set(url, this.now() + NEGATIVE_TTL_MS);
        throw err;
      },
    );
    this.entries.set(url, fresh);
    return fresh.promise;
  }

  /** Drop a source (e.g. its origin file changed). */
  invalidate(url) {
    this._remove(url);
  }

  _remove(url) {
    const entry = this.entries.get(url);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(url);
  }

  _evict() {
    // Map iteration order = least recently used first. Never evict pending inits.
    for (const [url, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      if (!entry.source) continue;
      this._remove(url);
      this.stats.evictions++;
    }
  }

  snapshot() {
    return { sources: this.entries.size, bytes: this.bytes, missing: this.missing.size, ...this.stats };
  }
}
