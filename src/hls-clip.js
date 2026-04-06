/**
 * HLS-to-HLS Clipper
 *
 * Clips an HLS stream to a time range. All segments use original CDN
 * URLs — zero downloading, zero re-muxing. The clipper just parses the
 * playlist, picks the overlapping segments, and computes the timing
 * offsets for the player.
 *
 * The result includes:
 * - `prerollDuration` — seek here on load (skip keyframe preroll)
 * - `playbackEnd` — pause here (end of requested clip)
 * - `duration` — the requested clip length (for UI)
 *
 * @module hls-clip
 *
 * @example
 * const clip = await clipHls('https://example.com/stream.m3u8', {
 *   startTime: 30,
 *   endTime: 90,
 * });
 *
 * // Player integration:
 * video.currentTime = clip.prerollDuration;
 * video.addEventListener('timeupdate', () => {
 *   if (video.currentTime >= clip.playbackEnd) video.pause();
 * });
 */

import { parseHls, parsePlaylistText } from './hls.js';

// ── HlsClipResult ─────────────────────────────────────────

class HlsClipResult {
  constructor({ variants, duration, startTime, endTime, prerollDuration, mediaDuration }) {
    this._variants = variants;
    /** Requested clip duration in seconds. */
    this.duration = duration;
    this.startTime = startTime;
    this.endTime = endTime;
    /** Seconds from the start of the media to where playback should begin.
     *  The player should seek here on load: `video.currentTime = clip.prerollDuration` */
    this.prerollDuration = prerollDuration;
    /** Total media duration including preroll. This is what `video.duration` will report. */
    this.mediaDuration = mediaDuration;
    /** The time at which the player should pause (preroll + requested duration). */
    this.playbackEnd = prerollDuration + duration;
  }

  get variantCount() {
    return this._variants.length;
  }

  get masterPlaylist() {
    if (this._variants.length === 1) return this.getMediaPlaylist(0);
    let m3u8 = '#EXTM3U\n';
    for (let i = 0; i < this._variants.length; i++) {
      const v = this._variants[i];
      const res = v.resolution ? `,RESOLUTION=${v.resolution}` : '';
      m3u8 += `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth}${res}\n`;
      m3u8 += `variant-${i}.m3u8\n`;
    }
    return m3u8;
  }

  getMediaPlaylist(variantIndex = 0) {
    const variant = this._variants[variantIndex];
    if (!variant) throw new Error(`Variant ${variantIndex} not found`);

    const maxDur = Math.max(...variant.segments.map(s => s.duration));

    let m3u8 = '#EXTM3U\n';
    m3u8 += '#EXT-X-VERSION:3\n';
    m3u8 += `#EXT-X-TARGETDURATION:${Math.ceil(maxDur)}\n`;
    m3u8 += '#EXT-X-PLAYLIST-TYPE:VOD\n';
    m3u8 += '#EXT-X-MEDIA-SEQUENCE:0\n';

    for (const seg of variant.segments) {
      m3u8 += `#EXTINF:${seg.duration.toFixed(6)},\n`;
      m3u8 += `${seg.url}\n`;
    }
    m3u8 += '#EXT-X-ENDLIST\n';
    return m3u8;
  }
}

// ── main ──────────────────────────────────────────────────

/**
 * Clip an HLS stream to a time range.
 *
 * All segments use original CDN URLs. No downloading, no re-muxing.
 * The player handles frame accuracy via seek and pause.
 *
 * @param {string} source - HLS URL (master or media playlist)
 * @param {object} options
 * @param {number} options.startTime - Start time in seconds
 * @param {number} options.endTime - End time in seconds
 * @param {string|number} [options.quality] - 'highest', 'lowest', or bandwidth
 * @param {function} [options.onProgress] - Progress callback
 * @returns {Promise<HlsClipResult>}
 */
export async function clipHls(source, options = {}) {
  const { startTime, endTime, quality, onProgress: log = () => {} } = options;
  if (startTime === undefined || endTime === undefined) {
    throw new Error('clipHls requires both startTime and endTime');
  }

  log('Parsing HLS playlist...');
  const stream = typeof source === 'string' ? await parseHls(source, { onProgress: log }) : source;

  let variantsToProcess = [];
  if (stream.isMaster) {
    const sorted = stream.qualities;
    if (quality === 'highest') variantsToProcess = [sorted[0]];
    else if (quality === 'lowest') variantsToProcess = [sorted[sorted.length - 1]];
    else if (typeof quality === 'number') { stream.select(quality); variantsToProcess = [stream.selected]; }
    else variantsToProcess = sorted;
  } else {
    variantsToProcess = [{ url: null, bandwidth: 0, resolution: null, _segments: stream.segments }];
  }

  log(`Processing ${variantsToProcess.length} variant(s)...`);

  const variants = [];
  let prerollDuration = 0;

  for (let vi = 0; vi < variantsToProcess.length; vi++) {
    const variant = variantsToProcess[vi];
    log(`Variant ${vi}: ${variant.resolution || variant.bandwidth || 'default'}`);

    let segments;
    if (variant._segments) {
      segments = variant._segments;
    } else {
      const resp = await fetch(variant.url);
      if (!resp.ok) throw new Error(`Failed to fetch media playlist: ${resp.status}`);
      const parsed = parsePlaylistText(await resp.text(), variant.url);
      segments = parsed.segments;
    }

    if (!segments.length) throw new Error('No segments found');

    // Find segments that overlap the clip range
    const overlapping = segments.filter(seg => seg.endTime > startTime && seg.startTime < endTime);
    if (!overlapping.length) throw new Error('No segments overlap the clip range');

    const firstSeg = overlapping[0];
    const lastSeg = overlapping[overlapping.length - 1];

    // Preroll: time from the first segment's start to the requested startTime.
    // The first segment starts at a keyframe (HLS spec requirement).
    // The player seeks past this to reach the requested start.
    if (vi === 0) {
      prerollDuration = Math.max(0, startTime - firstSeg.startTime);
    }

    // Build segment list — all original CDN URLs
    const clipSegments = overlapping.map(seg => ({
      duration: seg.duration,
      url: seg.url,
    }));

    const totalDuration = clipSegments.reduce((sum, s) => sum + s.duration, 0);
    log(`Clip ready: ${totalDuration.toFixed(2)}s (${clipSegments.length} segments, preroll: ${prerollDuration.toFixed(2)}s)`);

    variants.push({
      bandwidth: variant.bandwidth || 0,
      resolution: variant.resolution || null,
      segments: clipSegments,
    });
  }

  const mediaDuration = variants.length > 0
    ? variants[0].segments.reduce((sum, s) => sum + s.duration, 0)
    : endTime - startTime;

  return new HlsClipResult({
    variants,
    duration: endTime - startTime,
    startTime,
    endTime,
    prerollDuration,
    mediaDuration,
  });
}

export { HlsClipResult };
export default clipHls;
