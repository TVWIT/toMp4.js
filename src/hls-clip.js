/**
 * HLS-to-HLS Clipper
 *
 * Clips an HLS stream to a time range, producing a new HLS playlist.
 * Middle segments use original CDN URLs (completely untouched).
 * Boundary segments are re-muxed from the keyframe nearest to the
 * requested start/end times.
 *
 * The result includes `prerollDuration` — the time between the actual
 * start (keyframe) and the requested start. The player should seek
 * past this on load for frame-accurate playback:
 *
 *   video.currentTime = clip.prerollDuration;
 *
 * @module hls-clip
 *
 * @example
 * const clip = await clipHls('https://example.com/stream.m3u8', {
 *   startTime: 30,
 *   endTime: 90,
 * });
 *
 * clip.prerollDuration       // seconds to seek past for frame accuracy
 * clip.getMediaPlaylist(0)   // HLS playlist
 * await clip.getSegment(0, 0) // boundary TS data
 */

import { parseHls, parsePlaylistText } from './hls.js';
import { TSParser } from './parsers/mpegts.js';
import { TSMuxer } from './muxers/mpegts.js';

const PTS_PER_SECOND = 90000;

// ── helpers ───────────────────────────────────────────────

function parseTs(tsData) {
  const parser = new TSParser();
  parser.parse(tsData);
  parser.finalize();
  return parser;
}

function isKeyframe(au) {
  for (const nal of au.nalUnits) {
    if ((nal[0] & 0x1F) === 5) return true;
  }
  return false;
}

function wrapADTS(aacData, sampleRate, channels) {
  const RATES = [96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
  const sri = RATES.indexOf(sampleRate);
  const len = aacData.length + 7;
  const adts = new Uint8Array(len);
  adts[0] = 0xFF;
  adts[1] = 0xF1;
  adts[2] = (1 << 6) | ((sri < 0 ? 4 : sri) << 2) | ((channels >> 2) & 1);
  adts[3] = ((channels & 3) << 6) | ((len >> 11) & 3);
  adts[4] = (len >> 3) & 0xFF;
  adts[5] = ((len & 7) << 5) | 0x1F;
  adts[6] = 0xFC;
  adts.set(aacData, 7);
  return adts;
}

function muxToTs(videoAUs, audioAUs, audioSampleRate, audioChannels) {
  const muxer = new TSMuxer();

  let sps = null, pps = null;
  for (const au of videoAUs) {
    for (const nal of au.nalUnits) {
      const t = nal[0] & 0x1F;
      if (t === 7 && !sps) sps = nal;
      if (t === 8 && !pps) pps = nal;
    }
    if (sps && pps) break;
  }
  if (sps && pps) muxer.setSpsPps(sps, pps);
  muxer.setHasAudio(audioAUs.length > 0);

  const sr = audioSampleRate || 48000;
  const ch = audioChannels || 2;
  for (const au of audioAUs) {
    const hasADTS = au.data.length > 1 && au.data[0] === 0xFF && (au.data[1] & 0xF0) === 0xF0;
    muxer.addAudioSample(hasADTS ? au.data : wrapADTS(au.data, sr, ch), au.pts);
  }

  for (const au of videoAUs) {
    muxer.addVideoNalUnits(au.nalUnits, isKeyframe(au), au.pts, au.dts);
  }

  return muxer.build();
}

/**
 * Clip a parsed TS segment. Starts at nearest keyframe, ends at endTime.
 * Returns the preroll (time from keyframe to requested start).
 */
function clipSegment(parser, startTime, endTime) {
  const startPts = (startTime !== undefined ? startTime : 0) * PTS_PER_SECOND;
  const endPts = (endTime !== undefined ? endTime : Infinity) * PTS_PER_SECOND;
  const videoAUs = parser.videoAccessUnits;
  const audioAUs = parser.audioAccessUnits;

  if (videoAUs.length === 0) return null;

  // Find keyframe at or before startTime
  let keyframeIdx = 0;
  for (let i = 0; i < videoAUs.length; i++) {
    if (videoAUs[i].pts > startPts) break;
    if (isKeyframe(videoAUs[i])) keyframeIdx = i;
  }

  // Find end
  let endIdx = videoAUs.length;
  for (let i = keyframeIdx; i < videoAUs.length; i++) {
    if (videoAUs[i].pts >= endPts) { endIdx = i; break; }
  }

  const clipped = videoAUs.slice(keyframeIdx, endIdx);
  if (clipped.length === 0) return null;

  const keyframePts = clipped[0].pts;
  const prerollPts = Math.max(0, startPts - keyframePts);

  // Audio from keyframe (same timeline as video for A/V sync)
  const lastVideoPts = clipped[clipped.length - 1].pts;
  const audioEndPts = Math.min(endPts, lastVideoPts + PTS_PER_SECOND);
  const clippedAudio = audioAUs.filter(au => au.pts >= keyframePts && au.pts < audioEndPts);

  // Normalize to PTS 0
  const offset = keyframePts;
  for (const au of clipped) { au.pts -= offset; au.dts -= offset; }
  for (const au of clippedAudio) { au.pts -= offset; }

  const frameDur = clipped.length > 1 ? clipped[1].dts - clipped[0].dts : 3003;
  const duration = (clipped[clipped.length - 1].dts - clipped[0].dts + frameDur) / PTS_PER_SECOND;

  const tsData = muxToTs(clipped, clippedAudio, parser.audioSampleRate, parser.audioChannels);

  return {
    data: tsData,
    duration,
    preroll: prerollPts / PTS_PER_SECOND,
  };
}

// ── HlsClipResult ─────────────────────────────────────────

class HlsClipResult {
  /**
   * @param {object} opts
   * @param {number} opts.prerollDuration - Seconds to seek past for frame accuracy
   */
  constructor({ variants, duration, startTime, endTime, prerollDuration, mediaDuration }) {
    this._variants = variants;
    /** Requested clip duration in seconds. */
    this.duration = duration;
    this.startTime = startTime;
    this.endTime = endTime;
    /** Seconds from the start of the media to where playback should begin.
     *  The player should seek here on load: `video.currentTime = clip.prerollDuration` */
    this.prerollDuration = prerollDuration;
    /** Total media duration including preroll. This is what `video.duration` will report.
     *  The player should pause when: `video.currentTime >= clip.playbackEnd` */
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

    for (let i = 0; i < variant.segments.length; i++) {
      const seg = variant.segments[i];
      m3u8 += `#EXTINF:${seg.duration.toFixed(6)},\n`;
      m3u8 += seg.originalUrl || `segment-${variantIndex}-${i}.ts\n`;
    }
    m3u8 += '#EXT-X-ENDLIST\n';
    return m3u8;
  }

  async getSegment(variantIndex = 0, segmentIndex = 0) {
    const variant = this._variants[variantIndex];
    if (!variant) throw new Error(`Variant ${variantIndex} not found`);
    const seg = variant.segments[segmentIndex];
    if (!seg) throw new Error(`Segment ${segmentIndex} not found`);
    if (seg.data) return seg.data;
    if (seg.originalUrl) {
      const resp = await fetch(seg.originalUrl);
      if (!resp.ok) throw new Error(`Segment fetch failed: ${resp.status}`);
      return new Uint8Array(await resp.arrayBuffer());
    }
    return null;
  }
}

// ── main ──────────────────────────────────────────────────

/**
 * Clip an HLS stream to a time range.
 *
 * Boundary segments start at the nearest keyframe. The result includes
 * `prerollDuration` — the player should seek to this time on load for
 * frame-accurate start.
 *
 * Middle segments use original CDN URLs (completely untouched).
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

    const overlapping = segments.filter(seg => seg.endTime > startTime && seg.startTime < endTime);
    if (!overlapping.length) throw new Error('No segments overlap the clip range');

    const firstSeg = overlapping[0];
    const lastSeg = overlapping[overlapping.length - 1];
    const isSingleSegment = overlapping.length === 1;

    log(`Segments: ${overlapping.length} (${firstSeg.startTime.toFixed(1)}s – ${lastSeg.endTime.toFixed(1)}s)`);

    // Download and clip first boundary segment
    log('Downloading boundary segments...');
    const firstData = new Uint8Array(await (await fetch(firstSeg.url)).arrayBuffer());
    const firstParser = parseTs(firstData);
    const firstRelStart = startTime - firstSeg.startTime;
    const firstRelEnd = isSingleSegment ? endTime - firstSeg.startTime : undefined;
    const firstClipped = clipSegment(firstParser, firstRelStart, firstRelEnd);
    if (!firstClipped) throw new Error('First segment clip produced no samples');

    // Preroll from the first variant (all variants have similar GOP structure)
    if (vi === 0) prerollDuration = firstClipped.preroll;

    const clipSegments = [];

    clipSegments.push({
      duration: firstClipped.duration,
      data: firstClipped.data,
      originalUrl: null,
    });

    // Middle segments: original CDN URLs
    for (let i = 1; i < overlapping.length - 1; i++) {
      clipSegments.push({
        duration: overlapping[i].duration,
        data: null,
        originalUrl: overlapping[i].url,
      });
    }

    // Last boundary segment
    if (!isSingleSegment) {
      const lastData = new Uint8Array(await (await fetch(lastSeg.url)).arrayBuffer());
      const lastParser = parseTs(lastData);
      const lastRelEnd = endTime - lastSeg.startTime;
      const lastClipped = clipSegment(lastParser, undefined, lastRelEnd);
      if (lastClipped && lastClipped.data) {
        clipSegments.push({
          duration: lastClipped.duration,
          data: lastClipped.data,
          originalUrl: null,
        });
      }
    }

    const totalDuration = clipSegments.reduce((sum, s) => sum + s.duration, 0);
    log(`Clip ready: ${totalDuration.toFixed(2)}s (${clipSegments.length} segments, preroll: ${firstClipped.preroll.toFixed(2)}s)`);

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
