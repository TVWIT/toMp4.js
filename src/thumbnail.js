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
import { convertTsToMp4 } from './ts-to-mp4.js';
import { TSParser } from './parsers/mpegts.js';
import { MP4Muxer } from './muxers/mp4.js';
import { parseHls, downloadHls, parsePlaylistText, toAbsoluteUrl } from './hls.js';

const PTS_PER_SECOND = 90000;

// Build a display-order frame timeline from a parsed TS segment.
// Each entry is { startSec, endSec } describing the frame's display window.
// The first decoded frame in an HLS segment is an IDR keyframe, which is also
// first in display order, so after parser.normalizeTimestamps() its pts == 0.
// That makes pts/90000 the frame's presentation time in the resulting MP4.
function buildFrameTimeline(parser) {
  const frames = parser.videoAccessUnits
    .map((au) => au.pts / PTS_PER_SECOND)
    .sort((a, b) => a - b);
  if (frames.length === 0) return [];
  const timeline = new Array(frames.length);
  for (let i = 0; i < frames.length - 1; i++) {
    timeline[i] = { startSec: frames[i], endSec: frames[i + 1] };
  }
  // Approximate the last frame's duration with the previous interval.
  const tail = frames.length >= 2
    ? frames[frames.length - 1] - frames[frames.length - 2]
    : 1 / 30;
  timeline[frames.length - 1] = {
    startSec: frames[frames.length - 1],
    endSec: frames[frames.length - 1] + tail,
  };
  return timeline;
}

// Snap-back: the frame whose display window contains targetSec, matching the
// behavior of MSE/hls.js (largest start ≤ targetSec).
function pickFrame(timeline, targetSec) {
  if (timeline.length === 0) return -1;
  if (targetSec <= timeline[0].startSec) return 0;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].startSec <= targetSec) return i;
  }
  return 0;
}

// Exported for tests; not part of the public API.
export const __test__ = { buildFrameTimeline, pickFrame };

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

// Wait for the next painted video frame and return its mediaTime, or null if
// the browser doesn't support requestVideoFrameCallback (Firefox <130, etc.).
function nextRenderedFrame(video) {
  if (typeof video.requestVideoFrameCallback !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, 250);
    video.requestVideoFrameCallback((_now, meta) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(meta?.mediaTime ?? null);
    });
  });
}

// Seek so that the frame whose display window contains targetSec is the one
// the browser actually paints. We aim at the middle of the window so floating
// point and per-browser snap rules don't push us into a neighbor; if rVFC
// reports a mismatch we nudge once toward the target.
async function seekToFrame(video, timeline, targetSec) {
  const dur = Number.isFinite(video.duration) ? video.duration : 0;
  const clamped = Math.max(0, dur > 0 ? Math.min(targetSec, dur - 1e-3) : targetSec);

  if (!timeline || timeline.length === 0) {
    await seek(video, clamped);
    return;
  }

  const frameIdx = pickFrame(timeline, clamped);
  const frame = timeline[frameIdx];
  const aim = (frame.startSec + frame.endSec) / 2;
  await seek(video, aim);

  const actual = await nextRenderedFrame(video);
  if (actual == null) return; // rVFC unsupported — trust the seek
  if (actual >= frame.startSec && actual < frame.endSec) return;

  // Browser snapped to a neighbor. Nudge by a quarter-window toward the target
  // and re-seek once.
  const quarter = (frame.endSec - frame.startSec) / 4;
  const nudge = actual < frame.startSec ? aim + quarter : aim - quarter;
  await seek(video, Math.max(0, nudge));
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
 * once, and reuses video elements and canvases across captures.
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
 * @param {boolean} [options.accurate=false] - If true, always fetch full media
 *   segments and extract the exact frame at each requested time. Use this
 *   when you need the thumbnail to match what the player shows at time `t`
 *   (scene descriptions, title cards, etc.). Default prefers the I-frame
 *   playlist when one exists — faster, but snaps to the nearest keyframe,
 *   which can be several seconds away from the requested time.
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
    accurate = false,
  } = options;

  if (!times || !times.length) return new Map();

  const run = async () => {
    // Step 1: Parse the HLS playlist once
    let stream = input;
    if (typeof input === 'string') {
      stream = await parseHls(input);
    }

    // Step 2: Resolve to media segments.
    // Prefer I-frame playlist when available (single keyframe per segment,
    // ~9KB vs ~280KB, no seeking needed).
    let segments;
    let isIframeMode = false;

    if (!accurate && stream.isMaster && stream.iframeVariants && stream.iframeVariants.length > 0) {
      // Use I-frame playlist — pick lowest bandwidth variant
      const sorted = [...stream.iframeVariants].sort((a, b) => a.bandwidth - b.bandwidth);
      const iframeVariant = sorted[0];
      const resp = await fetch(iframeVariant.url);
      if (!resp.ok) throw new Error(`Failed to fetch I-frame playlist: ${resp.status}`);
      const text = await resp.text();
      const parsed = parsePlaylistText(text, iframeVariant.url);
      segments = parsed.segments;
      isIframeMode = segments.length > 0;
    }

    if (!isIframeMode) {
      // Fallback: use regular variant playlist
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
    }

    if (!segments || segments.length === 0) {
      throw new Error('No segments found in playlist');
    }

    // Step 3: Group requested times by segment.
    // In I-frame mode each segment is one keyframe, so we snap each time
    // to the nearest I-frame segment (1:1 mapping, no seeking needed).
    // In regular mode, multiple times may fall within one segment.
    const sortedTimes = [...times].sort((a, b) => a - b);
    const segmentGroups = new Map();

    if (isIframeMode) {
      // Each time maps to the nearest I-frame segment
      for (const t of sortedTimes) {
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < segments.length; i++) {
          const mid = segments[i].startTime + segments[i].duration / 2;
          const dist = Math.abs(t - mid);
          if (dist < bestDist) { bestDist = dist; bestIdx = i; }
        }
        if (!segmentGroups.has(bestIdx)) {
          segmentGroups.set(bestIdx, { segment: segments[bestIdx], times: [] });
        }
        segmentGroups.get(bestIdx).times.push(t);
      }
    } else {
      for (const t of sortedTimes) {
        let segIdx = segments.length - 1;
        for (let i = 0; i < segments.length; i++) {
          if (t < segments[i].endTime) { segIdx = i; break; }
        }
        if (!segmentGroups.has(segIdx)) {
          segmentGroups.set(segIdx, { segment: segments[segIdx], times: [] });
        }
        segmentGroups.get(segIdx).times.push(t);
      }
    }

    // Step 4: Prefetch all segments in parallel (network is the bottleneck).
    // In I-frame mode these are ~9KB each; in regular mode ~280KB each.
    const groups = [...segmentGroups.values()];
    const fetchPromises = groups.map(({ segment }) =>
      fetch(segment.url).then(r => {
        if (!r.ok) throw new Error(`Segment fetch failed: ${r.status}`);
        return r.arrayBuffer();
      })
    );

    // Step 5: Process with a concurrent worker pool.
    // Each worker owns one reusable video element and canvas.
    const results = new Map();
    let next = 0;

    // Detect iOS for play/pause kick (only platform that needs it)
    const needsPlayKick = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    async function worker() {
      // Each worker gets its own reusable video + canvas + offscreen host
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-99999px;top:0;width:1px;height:1px;overflow:hidden';
      host.appendChild(video);
      document.body.appendChild(host);

      let canvas = null;
      let ctx = null;
      let canvasW = 0;
      let canvasH = 0;

      try {
        while (next < groups.length) {
          const idx = next++;
          const { segment, times: groupTimes } = groups[idx];

          // Wait for this segment's prefetch to complete
          const buf = await fetchPromises[idx];

          // Drive the parser ourselves so we get the per-frame PTS timeline
          // alongside the MP4 bytes. In I-frame mode the segment is a single
          // keyframe and we don't need it.
          let timeline = null;
          let mp4Data;
          if (isIframeMode) {
            mp4Data = convertTsToMp4(new Uint8Array(buf));
          } else {
            const parser = new TSParser();
            parser.parse(new Uint8Array(buf));
            parser.finalize();
            timeline = buildFrameTimeline(parser);
            mp4Data = new MP4Muxer(parser).build();
          }
          const blob = new Blob([mp4Data], { type: 'video/mp4' });
          const mediaUrl = URL.createObjectURL(blob);

          try {
            video.src = mediaUrl;
            await waitOnce(video, 'loadeddata');

            if (needsPlayKick) {
              try { await video.play(); video.pause(); } catch {}
            }

            // Size canvas on first use or if dimensions change
            const vw = video.videoWidth || 1;
            const vh = video.videoHeight || 1;
            const scale = Math.min(1, maxWidth / vw);
            const outW = Math.max(1, Math.round(vw * scale));
            const outH = Math.max(1, Math.round(vh * scale));

            if (!canvas || outW !== canvasW || outH !== canvasH) {
              canvas = document.createElement('canvas');
              canvas.width = outW;
              canvas.height = outH;
              ctx = canvas.getContext('2d', { willReadFrequently: false });
              canvasW = outW;
              canvasH = outH;
            }

            for (const t of groupTimes) {
              // In I-frame mode, each segment is one frame — no seek needed.
              // In regular mode, pick the exact frame ourselves and seek inside
              // its display window so the browser snap is deterministic.
              if (!isIframeMode) {
                await seekToFrame(video, timeline, t - segment.startTime);
              }

              ctx.drawImage(video, 0, 0, canvasW, canvasH);

              const imageBlob = await new Promise((resolve, reject) => {
                canvas.toBlob(
                  b => b ? resolve(b) : reject(new Error('toBlob failed')),
                  mimeType, quality
                );
              });
              const image = new ImageResult(imageBlob, mimeType === 'image/png' ? 'thumbnail.png' : 'thumbnail.jpg');
              results.set(t, image);
              onThumbnail?.(t, image);
            }
          } finally {
            URL.revokeObjectURL(mediaUrl);
          }
        }
      } finally {
        try { video.pause(); video.removeAttribute('src'); video.load(); } catch {}
        try { host.remove(); } catch {}
      }
    }

    const workerCount = Math.min(concurrency, groups.length);
    const workers = [];
    for (let i = 0; i < workerCount; i++) workers.push(worker());
    await Promise.all(workers);

    return results;
  };

  return await withTimeout(run(), timeoutMs, 'Batch thumbnail generation timed out');
}
