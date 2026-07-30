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
 * Encode PCM to MP3, writing each frame to a StreamTarget as it is produced
 * (never holding the whole MP3 in memory). MP3 frames are self-contained, so
 * this is exact — the bytes are identical to encodeMp3().
 * @param {Int16Array|Float32Array|Array} channels - one channel, or [L,R]
 * @param {StreamTarget} target
 * @param {object} [opts] - { sampleRate=48000, bitRate=128 }
 */
export async function streamMp3(channels, target, opts = {}) {
  const sampleRate = opts.sampleRate || 48000;
  const bitRate = opts.bitRate || 128;
  const chans = Array.isArray(channels) && (channels[0] instanceof Int16Array || channels[0] instanceof Float32Array)
    ? channels.map(toInt16)
    : [toInt16(channels)];
  const nCh = chans.length;
  const enc = new Mp3Encoder(nCh, sampleRate, bitRate);
  const n = chans[0].length;
  const CHUNK = 1152 * 8; // encode several frames per pull
  for (let i = 0; i < n; i += CHUNK) {
    const frames = nCh === 2
      ? enc.encodeBuffer(chans[0].subarray(i, i + CHUNK), chans[1].subarray(i, i + CHUNK))
      : enc.encodeBuffer(chans[0].subarray(i, i + CHUNK));
    if (frames.length) await target.write(frames);
  }
  const tail = enc.flush();
  if (tail.length) await target.write(tail);
  await target.close();
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

/**
 * Extract the audio of a demuxed-CMAF HLS master and encode it to MP3.
 * Browser-only (decode uses Web Audio). Resolves the variant's #EXT-X-MEDIA
 * audio rendition, muxes it to an M4A, decodes, and encodes.
 * @param {string} masterUrl
 * @param {object} [opts] - { bitRate=128, quality, filename }
 * @returns {Promise<Mp3Result>}
 */
export async function hlsAudioToMp3(masterUrl, opts = {}) {
  const { parseHls, parsePlaylistText, resolveAudioRendition } = await import('../hls.js');
  const { convertFmp4ToMp4 } = await import('../fmp4/index.js');
  const stream = await parseHls(masterUrl, opts);
  if (opts.quality) stream.select(opts.quality);
  const audio = resolveAudioRendition(stream, stream.selected);
  if (!audio) throw new Error('hlsAudioToMp3: no demuxed audio rendition found');
  const media = parsePlaylistText(await (await fetch(audio.url)).text(), audio.url);
  const bufs = [];
  if (media.initSegmentUrl) bufs.push(new Uint8Array(await (await fetch(media.initSegmentUrl)).arrayBuffer()));
  for (const seg of media.segments) bufs.push(new Uint8Array(await (await fetch(seg.url)).arrayBuffer()));
  const total = bufs.reduce((s, b) => s + b.length, 0);
  const audioFmp4 = new Uint8Array(total);
  let o = 0; for (const b of bufs) { audioFmp4.set(b, o); o += b.length; }
  const m4a = convertFmp4ToMp4(audioFmp4);         // audio-only M4A
  return audioToMp3(m4a, { bitRate: opts.bitRate || 128, filename: opts.filename || 'audio.mp3' });
}

export { Mp3Encoder };
