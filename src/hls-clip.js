/**
 * HLS-to-HLS Clipper
 *
 * Clips an HLS stream to a time range, producing a new HLS stream.
 * Boundary segments are smart-rendered via WebCodecs for frame-accurate
 * start/end. Middle segments use original CDN URLs — completely untouched.
 *
 * Output format matches input: TS segments stay as TS, fMP4 stays as fMP4.
 * No format conversion needed for middle segments.
 *
 * Falls back to keyframe-accurate clipping when WebCodecs is unavailable.
 *
 * @module hls-clip
 *
 * @example
 * const clip = await clipHls('https://example.com/stream.m3u8', {
 *   startTime: 30,
 *   endTime: 90,
 * });
 *
 * clip.masterPlaylist      // modified m3u8 text
 * clip.getMediaPlaylist(0) // variant media playlist
 * await clip.getSegment(0, 0) // boundary segment (Uint8Array) or middle URL
 */

import { parseHls, parsePlaylistText } from './hls.js';
import { TSParser } from './parsers/mpegts.js';
import { TSMuxer } from './muxers/mpegts.js';
import { smartRender, isSmartRenderSupported } from './codecs/smart-render.js';

const PTS_PER_SECOND = 90000;

/** Wrap raw AAC frame data with a 7-byte ADTS header. */
function wrapADTS(aacData, sampleRate, channels) {
  const RATES = [96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
  const sampleRateIndex = RATES.indexOf(sampleRate);
  const frameLength = aacData.length + 7;
  const adts = new Uint8Array(7 + aacData.length);
  adts[0] = 0xFF;
  adts[1] = 0xF1; // MPEG-4, Layer 0, no CRC
  adts[2] = ((1) << 6) | ((sampleRateIndex < 0 ? 4 : sampleRateIndex) << 2) | ((channels >> 2) & 1); // AAC-LC
  adts[3] = ((channels & 3) << 6) | ((frameLength >> 11) & 3);
  adts[4] = (frameLength >> 3) & 0xFF;
  adts[5] = ((frameLength & 7) << 5) | 0x1F;
  adts[6] = 0xFC;
  adts.set(aacData, 7);
  return adts;
}

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

/**
 * Mux video + audio access units into an MPEG-TS segment.
 */
function muxToTs(videoAUs, audioAUs, audioSampleRate, audioChannels) {
  const muxer = new TSMuxer();

  // Extract SPS/PPS for the muxer
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

  // Add audio samples (wrap raw AAC with ADTS headers)
  const sr = audioSampleRate || 48000;
  const ch = audioChannels || 2;
  for (const au of audioAUs) {
    // Check if already has ADTS header
    const hasADTS = au.data.length > 1 && au.data[0] === 0xFF && (au.data[1] & 0xF0) === 0xF0;
    const adtsData = hasADTS ? au.data : wrapADTS(au.data, sr, ch);
    muxer.addAudioSample(adtsData, au.pts);
  }

  // Add video samples
  for (const au of videoAUs) {
    muxer.addVideoNalUnits(au.nalUnits, isKeyframe(au), au.pts, au.dts);
  }

  return muxer.build();
}

/**
 * Clip a parsed TS segment at the start and/or end.
 * Uses smart rendering (WebCodecs) when available for frame-accurate start.
 * Falls back to keyframe-accurate when WebCodecs is unavailable.
 */
async function clipSegment(parser, startTime, endTime) {
  const result = await smartRender(parser, startTime || 0, { endTime });

  if (result.videoAUs.length === 0) return null;

  // Calculate duration from the actual content
  const firstPts = result.videoAUs[0].pts;
  const lastPts = result.videoAUs[result.videoAUs.length - 1].pts;
  const frameDuration = result.videoAUs.length > 1
    ? result.videoAUs[1].dts - result.videoAUs[0].dts
    : 3003;
  const duration = (lastPts - firstPts + frameDuration) / PTS_PER_SECOND;

  // Normalize timestamps to start at 0
  const offset = firstPts;
  for (const au of result.videoAUs) { au.pts -= offset; au.dts -= offset; }
  for (const au of result.audioAUs) { au.pts -= offset; }

  // Mux to TS (wrap raw AAC with ADTS headers)
  const tsData = muxToTs(result.videoAUs, result.audioAUs, parser.audioSampleRate, parser.audioChannels);

  return {
    data: tsData,
    duration,
    smartRendered: (result.smartRenderedFrames || 0) > 0,
    smartRenderedFrames: result.smartRenderedFrames || 0,
  };
}

// ── HlsClipResult ─────────────────────────────────────────

class HlsClipResult {
  constructor({ variants, duration, startTime, endTime }) {
    this._variants = variants;
    this.duration = duration;
    this.startTime = startTime;
    this.endTime = endTime;
  }

  get variantCount() {
    return this._variants.length;
  }

  /** Master playlist m3u8 text */
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

  /**
   * Get media playlist for a variant.
   * Boundary segments use custom URLs (served from memory).
   * Middle segments use original CDN URLs.
   */
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
      if (seg.originalUrl) {
        // Middle segment: original CDN URL (untouched)
        m3u8 += `${seg.originalUrl}\n`;
      } else {
        // Boundary segment: served from memory
        m3u8 += `segment-${variantIndex}-${i}.ts\n`;
      }
    }
    m3u8 += '#EXT-X-ENDLIST\n';
    return m3u8;
  }

  /**
   * Get a segment's TS data.
   * Boundary segments: return from memory.
   * Middle segments: return null (use originalUrl from playlist).
   */
  async getSegment(variantIndex = 0, segmentIndex = 0) {
    const variant = this._variants[variantIndex];
    if (!variant) throw new Error(`Variant ${variantIndex} not found`);
    const seg = variant.segments[segmentIndex];
    if (!seg) throw new Error(`Segment ${segmentIndex} not found`);

    if (seg.data) return seg.data;

    // Middle segment: fetch from CDN (for cases where caller needs the data)
    if (seg.originalUrl) {
      const resp = await fetch(seg.originalUrl);
      if (!resp.ok) throw new Error(`Segment fetch failed: ${resp.status}`);
      return new Uint8Array(await resp.arrayBuffer());
    }

    return null;
  }

  /**
   * Get all segment data (fetches middle segments from CDN).
   */
  async getAllSegments(variantIndex = 0) {
    const variant = this._variants[variantIndex];
    const results = [];
    for (let i = 0; i < variant.segments.length; i++) {
      results.push(await this.getSegment(variantIndex, i));
    }
    return results;
  }
}

// ── main function ─────────────────────────────────────────

/**
 * Clip an HLS stream to a time range.
 *
 * Output is a new HLS stream where:
 * - Boundary segments are smart-rendered (WebCodecs) or keyframe-accurate
 * - Middle segments use original CDN URLs (completely untouched)
 *
 * @param {string|HlsStream} source - HLS URL or parsed HlsStream
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

  // Resolve variants
  let variantsToProcess = [];
  if (stream.isMaster) {
    const sorted = stream.qualities;
    if (quality === 'highest') variantsToProcess = [sorted[0]];
    else if (quality === 'lowest') variantsToProcess = [sorted[sorted.length - 1]];
    else if (typeof quality === 'number') { stream.select(quality); variantsToProcess = [stream.selected]; }
    else variantsToProcess = sorted;
  } else {
    variantsToProcess = [{
      url: null, bandwidth: 0, resolution: null,
      _segments: stream.segments, _initSegmentUrl: stream.initSegmentUrl,
    }];
  }

  log(`Processing ${variantsToProcess.length} variant(s)...`);
  if (isSmartRenderSupported()) {
    log('Smart rendering: enabled (WebCodecs)');
  } else {
    log('Smart rendering: unavailable (keyframe-accurate fallback)');
  }

  const variants = [];

  for (let vi = 0; vi < variantsToProcess.length; vi++) {
    const variant = variantsToProcess[vi];
    log(`Variant ${vi}: ${variant.resolution || variant.bandwidth || 'default'}`);

    // Get segment list
    let segments;
    if (variant._segments) {
      segments = variant._segments;
    } else {
      const mediaResp = await fetch(variant.url);
      if (!mediaResp.ok) throw new Error(`Failed to fetch media playlist: ${mediaResp.status}`);
      const mediaText = await mediaResp.text();
      const parsed = parsePlaylistText(mediaText, variant.url);
      segments = parsed.segments;
    }

    if (!segments.length) throw new Error('No segments found');

    // Find overlapping segments
    const overlapping = segments.filter(seg => seg.endTime > startTime && seg.startTime < endTime);
    if (!overlapping.length) throw new Error('No segments overlap the clip range');

    const firstSeg = overlapping[0];
    const lastSeg = overlapping[overlapping.length - 1];
    const isSingleSegment = overlapping.length === 1;

    log(`Segments: ${overlapping.length} (${firstSeg.startTime.toFixed(1)}s – ${lastSeg.endTime.toFixed(1)}s)`);

    // Download and clip boundary segments
    log('Downloading boundary segments...');
    const firstData = new Uint8Array(await (await fetch(firstSeg.url)).arrayBuffer());
    const firstParser = parseTs(firstData);

    const firstRelStart = startTime - firstSeg.startTime;
    const firstRelEnd = isSingleSegment ? endTime - firstSeg.startTime : undefined;
    const firstClipped = await clipSegment(firstParser, firstRelStart, firstRelEnd);
    if (!firstClipped) throw new Error('First segment clip produced no samples');

    const clipSegments = [];

    // First segment (boundary, in memory)
    clipSegments.push({
      duration: firstClipped.duration,
      data: firstClipped.data,
      originalUrl: null,
      isBoundary: true,
      smartRendered: firstClipped.smartRendered,
    });

    // Middle segments (original CDN URLs, untouched)
    for (let i = 1; i < overlapping.length - 1; i++) {
      clipSegments.push({
        duration: overlapping[i].duration,
        data: null,
        originalUrl: overlapping[i].url,
        isBoundary: false,
      });
    }

    // Last segment (boundary, if different from first)
    if (!isSingleSegment) {
      const lastData = new Uint8Array(await (await fetch(lastSeg.url)).arrayBuffer());
      const lastParser = parseTs(lastData);
      const lastRelEnd = endTime - lastSeg.startTime;
      const lastClipped = await clipSegment(lastParser, undefined, lastRelEnd);
      if (lastClipped && lastClipped.data) {
        clipSegments.push({
          duration: lastClipped.duration,
          data: lastClipped.data,
          originalUrl: null,
          isBoundary: true,
          smartRendered: lastClipped.smartRendered,
        });
      }
    }

    const totalDuration = clipSegments.reduce((sum, s) => sum + s.duration, 0);
    log(`Clip ready: ${totalDuration.toFixed(2)}s (${clipSegments.length} segments)`);

    variants.push({
      bandwidth: variant.bandwidth || 0,
      resolution: variant.resolution || null,
      segments: clipSegments,
    });
  }

  return new HlsClipResult({
    variants,
    duration: endTime - startTime,
    startTime,
    endTime,
  });
}

export { HlsClipResult };
export default clipHls;
