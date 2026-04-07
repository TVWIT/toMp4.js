/**
 * Thumbnail extraction (browser-only)
 *
 * This is intentionally implemented using `<video>` + `<canvas>` instead of
 * container-level parsing, because decoding frames is the hard part:
 * browsers already have hardware decoders and seeking.
 *
 * For HLS inputs, we rely on toMp4() to remux a tiny time range into an MP4 clip
 * (downloads minimal segments). This also handles fMP4 EXT-X-MAP init segments
 * now that HLS parsing supports it.
 *
 * Limitations:
 * - Requires browser DOM APIs (document, HTMLVideoElement, canvas).
 * - For cross-origin URLs, the server must send `Access-Control-Allow-Origin`
 *   or the canvas will be tainted and pixel extraction will fail.
 */

import toMp4 from './index.js';
import { parseHls, downloadHls, parsePlaylistText, toAbsoluteUrl } from './hls.js';

export class ImageResult {
  constructor(blob, filename = 'thumbnail.jpg') {
    this.blob = blob;
    this.filename = filename;
    this._url = null;
  }

  toBlob() {
    return this.blob;
  }

  toURL() {
    if (!this._url) this._url = URL.createObjectURL(this.blob);
    return this._url;
  }

  revokeURL() {
    if (this._url) URL.revokeObjectURL(this._url);
    this._url = null;
  }

  download(filename) {
    const a = document.createElement('a');
    a.href = this.toURL();
    a.download = filename || this.filename;
    a.click();
  }
}

function isBrowser() {
  return typeof document !== 'undefined' && typeof window !== 'undefined';
}

function requireBrowser() {
  if (!isBrowser()) {
    throw new Error('toMp4.thumbnail() is browser-only (requires document/canvas).');
  }
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(t));
  });
}

async function waitOnce(target, eventName) {
  return new Promise((resolve, reject) => {
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error('Video failed to load'));
    };
    const cleanup = () => {
      target.removeEventListener(eventName, onOk);
      target.removeEventListener('error', onErr);
    };
    target.addEventListener(eventName, onOk, { once: true });
    target.addEventListener('error', onErr, { once: true });
  });
}

async function seek(video, timeSeconds) {
  return new Promise((resolve) => {
    const onSeeked = () => resolve();
    video.addEventListener('seeked', onSeeked, { once: true });
    try {
      video.currentTime = Math.max(0, timeSeconds);
    } catch {
      resolve();
    }
  });
}

/**
 * Extract a single frame as an image.
 *
 * @param {string|Uint8Array|ArrayBuffer|Blob|import('./hls.js').HlsStream|{init?:Uint8Array|ArrayBuffer, segments:(Uint8Array|ArrayBuffer)[]}} input
 * @param {object} [options]
 * @param {number} [options.time] - Time in seconds for the capture (default 0.15)
 * @param {number} [options.maxWidth] - Resize output to this width (preserve aspect)
 * @param {string} [options.mimeType] - 'image/jpeg' | 'image/webp' | 'image/png'
 * @param {number} [options.quality] - 0..1 (jpeg/webp)
 * @param {number} [options.timeoutMs] - Overall timeout (default 15000)
 * @param {string} [options.hlsQuality] - 'lowest' | 'highest' (default 'lowest')
 * @returns {Promise<ImageResult>}
 */
export async function thumbnail(input, options = {}) {
  requireBrowser();

  const {
    time = 0.15,
    maxWidth = 480,
    mimeType = 'image/jpeg',
    quality = 0.82,
    timeoutMs = 15000,
    hlsQuality = 'lowest',
  } = options;

  // If input is fragmented-only fMP4, allow caller to provide init+segments.
  // This addresses the "no ftyp/moov" case: fragments alone are not decodable
  // without codec init data.
  let mp4Cleanup = null;
  let mediaUrl = null;
  let localSeek = time;

  const isHlsLike =
    typeof input === 'string' ? toMp4.isHlsUrl(input) : false;

  const buildMp4Clip = async () => {
    const clipEnd = time + 1.5;
    const mp4 = await toMp4(input, {
      startTime: time,
      endTime: clipEnd,
      quality: hlsQuality,
      onProgress: () => {},
    });
    mp4Cleanup = () => mp4.revokeURL();
    mediaUrl = mp4.toURL();
    // The clip is normalized to requested start at t=0.
    localSeek = 0;
  };

  const isSegmentsObject =
    input &&
    typeof input === 'object' &&
    !ArrayBuffer.isView(input) &&
    !(input instanceof ArrayBuffer) &&
    !(input instanceof Blob) &&
    !('masterUrl' in input) && // HlsStream
    Array.isArray(input.segments);

  if (isSegmentsObject) {
    const init = input.init
      ? (input.init instanceof ArrayBuffer ? new Uint8Array(input.init) : input.init)
      : null;
    const segs = input.segments.map((s) =>
      s instanceof ArrayBuffer ? new Uint8Array(s) : s,
    );
    if (!init) {
      // fMP4 fragments (moof/mdat) are not decodable without the init segment (ftyp/moov).
      // This commonly comes from HLS playlists via EXT-X-MAP.
      throw new Error('Fragments-only input requires an init segment (ftyp/moov). Provide `init` (e.g. EXT-X-MAP) along with `segments`.');
    }
    const mp4 = toMp4.stitchFmp4(segs, init ? { init } : undefined);
    mp4Cleanup = () => mp4.revokeURL();
    mediaUrl = mp4.toURL();
    localSeek = time;
  } else if (isHlsLike || (input && typeof input === 'object' && input.masterUrl && input.variants)) {
    // HLS URL or HlsStream: make a tiny MP4 clip around the time.
    await buildMp4Clip();
  } else if (typeof input === 'string') {
    // Direct MP4 URL
    mediaUrl = input;
    localSeek = time;
  } else {
    // Raw bytes/blob: remux to an MP4 clip and capture from that.
    await buildMp4Clip();
  }

  const run = async () => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';

    const host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.left = '-99999px';
    host.style.top = '0';
    host.style.width = '1px';
    host.style.height = '1px';
    host.style.overflow = 'hidden';
    host.appendChild(video);
    document.body.appendChild(host);

    try {
      video.src = mediaUrl;
      await waitOnce(video, 'loadeddata');

      try {
        await video.play();
        video.pause();
      } catch {
        // ignore autoplay restrictions; muted should pass in most browsers
      }

      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      const safeTime = dur > 0 ? Math.min(localSeek, Math.max(0, dur - 0.05)) : localSeek;
      await seek(video, safeTime);

      const vw = video.videoWidth || 0;
      const vh = video.videoHeight || 0;
      if (!vw || !vh) throw new Error('No video frame available');

      const scale = Math.min(1, maxWidth / vw);
      const outW = Math.max(1, Math.round(vw * scale));
      const outH = Math.max(1, Math.round(vh * scale));

      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas not supported');

      ctx.drawImage(video, 0, 0, outW, outH);

      const blob = await new Promise((resolve, reject) => {
        try {
          canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error('Failed to encode thumbnail'))),
            mimeType,
            quality,
          );
        } catch (err) {
          reject(err);
        }
      });

      return new ImageResult(blob, mimeType === 'image/png' ? 'thumbnail.png' : 'thumbnail.jpg');
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (msg.toLowerCase().includes('taint') || msg.toLowerCase().includes('security')) {
        throw new Error('Canvas is tainted by cross-origin media. Ensure the server sets CORS headers (Access-Control-Allow-Origin).');
      }
      throw err;
    } finally {
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch {}
      try {
        host.remove();
      } catch {}
      try {
        mp4Cleanup?.();
      } catch {}
    }
  };

  return await withTimeout(run(), timeoutMs, 'Thumbnail generation timed out');
}

/**
 * Capture a frame from a video element at a given time.
 * Shared by thumbnails() to avoid duplicating the canvas logic.
 */
async function captureFrame(video, timeSeconds, { maxWidth, mimeType, quality }) {
  const dur = Number.isFinite(video.duration) ? video.duration : 0;
  const safeTime = dur > 0 ? Math.min(timeSeconds, Math.max(0, dur - 0.05)) : timeSeconds;
  await seek(video, safeTime);

  const vw = video.videoWidth || 0;
  const vh = video.videoHeight || 0;
  if (!vw || !vh) throw new Error('No video frame available');

  const scale = Math.min(1, maxWidth / vw);
  const outW = Math.max(1, Math.round(vw * scale));
  const outH = Math.max(1, Math.round(vh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not supported');

  ctx.drawImage(video, 0, 0, outW, outH);

  const blob = await new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Failed to encode thumbnail'))),
        mimeType,
        quality,
      );
    } catch (err) {
      reject(err);
    }
  });

  return new ImageResult(blob, mimeType === 'image/png' ? 'thumbnail.png' : 'thumbnail.jpg');
}

/**
 * Batch thumbnail extraction from an HLS stream.
 *
 * Parses the playlist once, groups times by segment, fetches each segment
 * once, and reuses a single video element per segment for all seeks.
 *
 * @param {string|import('./hls.js').HlsStream} input - HLS URL or HlsStream
 * @param {object} options
 * @param {number[]} options.times - Times in seconds to capture
 * @param {number} [options.maxWidth=80] - Resize output width
 * @param {string} [options.mimeType='image/jpeg'] - Output mime type
 * @param {number} [options.quality=0.6] - 0..1 (jpeg/webp)
 * @param {number} [options.timeoutMs=30000] - Overall timeout
 * @param {string} [options.hlsQuality='lowest'] - Variant selection
 * @param {number} [options.concurrency=4] - Max segments fetched in parallel
 * @param {function} [options.onThumbnail] - Called as each thumbnail completes: (time, imageResult) => void
 * @returns {Promise<Map<number, ImageResult>>}
 */
export async function thumbnails(input, options = {}) {
  requireBrowser();

  const {
    times,
    maxWidth = 80,
    mimeType = 'image/jpeg',
    quality = 0.6,
    timeoutMs = 30000,
    hlsQuality = 'lowest',
    concurrency = 4,
    onThumbnail,
  } = options;

  if (!times || !times.length) return new Map();

  const run = async () => {
    // Step 1: Parse the HLS playlist once
    let stream = input;
    if (typeof input === 'string') {
      stream = await parseHls(input);
    }

    // Step 2: Resolve to media segments
    let segments;
    if (stream.isMaster) {
      stream.select(hlsQuality);
      const variant = stream.selected;
      const resp = await fetch(variant.url);
      if (!resp.ok) throw new Error(`Failed to fetch media playlist: ${resp.status}`);
      const text = await resp.text();
      const parsed = parsePlaylistText(text, variant.url);
      segments = parsed.segments;
    } else {
      segments = stream.segments;
    }

    if (!segments || segments.length === 0) {
      throw new Error('No segments found in playlist');
    }

    // Step 3: Group requested times by segment
    const sortedTimes = [...times].sort((a, b) => a - b);
    const segmentGroups = new Map(); // segmentIndex → { segment, times[] }

    for (const t of sortedTimes) {
      // Find the segment containing this time
      let segIdx = segments.length - 1;
      for (let i = 0; i < segments.length; i++) {
        if (t < segments[i].endTime) {
          segIdx = i;
          break;
        }
      }
      if (!segmentGroups.has(segIdx)) {
        segmentGroups.set(segIdx, { segment: segments[segIdx], times: [] });
      }
      segmentGroups.get(segIdx).times.push(t);
    }

    // Step 4: Process segment groups with concurrency limit
    const results = new Map();
    const groups = [...segmentGroups.values()];

    // Process in batches of `concurrency`
    for (let i = 0; i < groups.length; i += concurrency) {
      const batch = groups.slice(i, i + concurrency);
      await Promise.all(batch.map(async ({ segment, times: groupTimes }) => {
        // Fetch segment data
        const resp = await fetch(segment.url);
        if (!resp.ok) throw new Error(`Segment fetch failed: ${resp.status}`);
        const tsData = new Uint8Array(await resp.arrayBuffer());

        // Transmux to MP4
        const mp4 = await toMp4(tsData);
        const mediaUrl = mp4.toURL();

        // Create one video element for all times in this segment
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';

        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:-99999px;top:0;width:1px;height:1px;overflow:hidden';
        host.appendChild(video);
        document.body.appendChild(host);

        try {
          video.src = mediaUrl;
          await waitOnce(video, 'loadeddata');

          // play/pause kick for iOS
          try { await video.play(); video.pause(); } catch {}

          // Seek to each time and capture
          for (const t of groupTimes) {
            const localTime = t - segment.startTime;
            const image = await captureFrame(video, localTime, { maxWidth, mimeType, quality });
            results.set(t, image);
            onThumbnail?.(t, image);
          }
        } finally {
          try { video.pause(); video.removeAttribute('src'); video.load(); } catch {}
          try { host.remove(); } catch {}
          mp4.revokeURL();
        }
      }));
    }

    return results;
  };

  return await withTimeout(run(), timeoutMs, 'Batch thumbnail generation timed out');
}
