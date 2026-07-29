/**
 * Write targets for streaming output to disk without holding the whole file in
 * memory. A target is an append-only sink with a positional patch (for the
 * mdat box size, which is only known once all media is written).
 *
 *   interface StreamTarget {
 *     position: number                        // current append offset
 *     write(chunk: Uint8Array): Promise<void>  // append
 *     writeAt(pos, chunk): Promise<void>       // patch bytes at an earlier offset
 *     close(): Promise<void>
 *   }
 */

/** In-memory target — the small-file fallback, and what tests write to. */
export class ArrayBufferTarget {
  constructor() { this._buf = new Uint8Array(1 << 16); this.position = 0; this._end = 0; }
  _ensure(size) {
    if (size <= this._buf.length) return;
    let n = this._buf.length;
    while (n < size) n *= 2;
    const nb = new Uint8Array(n);
    nb.set(this._buf.subarray(0, this._end));
    this._buf = nb;
  }
  async write(chunk) {
    this._ensure(this.position + chunk.length);
    this._buf.set(chunk, this.position);
    this.position += chunk.length;
    if (this.position > this._end) this._end = this.position;
  }
  async writeAt(pos, chunk) {
    this._ensure(pos + chunk.length);
    this._buf.set(chunk, pos);
    if (pos + chunk.length > this._end) this._end = pos + chunk.length;
  }
  async close() {}
  /** The finished bytes. */
  get buffer() { return this._buf.subarray(0, this._end); }
}

/** Browser target backed by a FileSystemWritableFileStream (File System Access). */
export class FileSystemWritableTarget {
  constructor(writable) { this._w = writable; this.position = 0; }
  async write(chunk) { await this._w.write(chunk); this.position += chunk.length; }
  async writeAt(pos, chunk) {
    await this._w.write({ type: 'write', position: pos, data: chunk });
    // restore the append cursor so subsequent write()s go to the end
    await this._w.write({ type: 'seek', position: this.position });
  }
  async close() { await this._w.close(); }
}

/** True when the browser can stream directly to disk. */
export function canStreamToDisk() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}

/**
 * Prompt for a save location and return a streaming target, or null if the
 * File System Access API is unavailable (caller should fall back to in-memory).
 * @param {string} suggestedName
 */
export async function pickDownloadTarget(suggestedName) {
  if (!canStreamToDisk()) return null;
  const handle = await window.showSaveFilePicker({ suggestedName });
  const writable = await handle.createWritable();
  return new FileSystemWritableTarget(writable);
}
