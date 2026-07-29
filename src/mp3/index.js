/**
 * MP3 module — from-scratch MPEG-1/2 Layer III encoder + friendly wrappers.
 * @module mp3
 */
import { Mp3Encoder } from './encoder.js';

/** Result of an MP3 encode — mirrors Mp4Result (download/toURL/toBlob/data). */
export class Mp3Result {
  constructor(data, filename = 'audio.mp3') { this.data = data; this.filename = filename; this._url = null; this._blob = null; }
  get size() { return this.data.byteLength; }
  toBlob() { return this._blob || (this._blob = new Blob([this.data], { type: 'audio/mpeg' })); }
  toURL() { return this._url || (this._url = URL.createObjectURL(this.toBlob())); }
  revokeURL() { if (this._url) { URL.revokeObjectURL(this._url); this._url = null; } }
  toArrayBuffer() { return this.data.buffer.slice(this.data.byteOffset, this.data.byteOffset + this.data.byteLength); }
  download(filename) { const a = document.createElement('a'); a.href = this.toURL(); a.download = filename || this.filename; a.click(); }
}

function toInt16(ch) {
  if (ch instanceof Int16Array) return ch;
  const out = new Int16Array(ch.length); // assume Float32 in [-1,1]
  for (let i = 0; i < ch.length; i++) {
    let v = Math.round(ch[i] * 32767);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

/**
 * Encode raw PCM to MP3.
 * @param {Int16Array|Float32Array|Array} channels - one channel, or [L,R]. Int16
 *   samples, or Float32 in [-1,1].
 * @param {object} [opts] - { sampleRate=48000, bitRate=128, filename }
 * @returns {Mp3Result}
 */
export function encodeMp3(channels, opts = {}) {
  const sampleRate = opts.sampleRate || 48000;
  const bitRate = opts.bitRate || 128;
  const chans = Array.isArray(channels) && (channels[0] instanceof Int16Array || channels[0] instanceof Float32Array)
    ? channels.map(toInt16)
    : [toInt16(channels)];
  const nCh = chans.length;
  const enc = new Mp3Encoder(nCh, sampleRate, bitRate);
  const n = chans[0].length;
  const parts = [];
  const CHUNK = 1152;
  for (let i = 0; i < n; i += CHUNK) {
    parts.push(nCh === 2
      ? enc.encodeBuffer(chans[0].subarray(i, i + CHUNK), chans[1].subarray(i, i + CHUNK))
      : enc.encodeBuffer(chans[0].subarray(i, i + CHUNK)));
  }
  parts.push(enc.flush());
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return new Mp3Result(out, opts.filename || 'audio.mp3');
}

/**
 * Decode a compressed-audio file (M4A/AAC/etc.) to PCM channels via Web Audio.
 * Browser-only. Returns { channels: Float32Array[], sampleRate }.
 */
export async function decodeToPcm(data) {
  const AC = (typeof AudioContext !== 'undefined' && AudioContext) ||
             (typeof OfflineAudioContext !== 'undefined' && OfflineAudioContext) ||
             (typeof globalThis !== 'undefined' && (globalThis.webkitAudioContext || globalThis.webkitOfflineAudioContext));
  if (!AC) throw new Error('decodeToPcm requires the Web Audio API (browser only).');
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const ctx = typeof OfflineAudioContext !== 'undefined'
    ? new OfflineAudioContext(1, 1, 48000)
    : new AC();
  const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const channels = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) channels.push(audioBuffer.getChannelData(c));
  return { channels, sampleRate: audioBuffer.sampleRate };
}

/**
 * Convert compressed audio (an M4A/AAC file's bytes) directly to an MP3.
 * Browser-only (decode step uses Web Audio). Nearest valid sample rate/bitrate
 * are chosen for MP3.
 * @param {Uint8Array|ArrayBuffer} audioData - a complete M4A/AAC/MP4-audio file
 * @param {object} [opts] - { bitRate=128, filename }
 * @returns {Promise<Mp3Result>}
 */
export async function audioToMp3(audioData, opts = {}) {
  const { channels, sampleRate } = await decodeToPcm(audioData);
  // MP3 supports a fixed set of sample rates; 48/44.1/32k cover normal audio.
  const supported = [48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
  const sr = supported.includes(sampleRate) ? sampleRate
    : supported.reduce((a, b) => Math.abs(b - sampleRate) < Math.abs(a - sampleRate) ? b : a);
  if (sr !== sampleRate) {
    // (resampling is out of scope here; most AAC decodes to 48k/44.1k already)
    throw new Error(`decoded sample rate ${sampleRate} is not an MP3 rate; resample to one of ${supported.join('/')}`);
  }
  return encodeMp3(channels.length === 2 ? channels : channels[0], { sampleRate: sr, bitRate: opts.bitRate || 128, filename: opts.filename });
}

export { Mp3Encoder };
