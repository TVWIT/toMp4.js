/**
 * HLS-to-HLS Clipper
 *
 * Clips an HLS stream to a time range, producing a new HLS stream with
 * CMAF (fMP4) segments. Boundary segments are pre-clipped with edit lists
 * for frame-accurate start/end. Middle segments are remuxed on-demand
 * from the original CDN source.
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
 * clip.getInitSegment(0)   // fMP4 init segment (Uint8Array)
 * await clip.getSegment(0, 0) // fMP4 media segment (Uint8Array)
 */

import { parseHls, isHlsUrl, parsePlaylistText, toAbsoluteUrl } from './hls.js';
import { TSParser, getCodecInfo } from './parsers/mpegts.js';
import { createInitSegment, createFragment } from './muxers/fmp4.js';
import { smartRender } from './codecs/smart-render.js';

// ── constants ─────────────────────────────────────────────

const PTS_PER_SECOND = 90000;

// ── helpers ───────────────────────────────────────────────

function isKeyframe(accessUnit) {
  for (const nalUnit of accessUnit.nalUnits) {
    if ((nalUnit[0] & 0x1F) === 5) return true;
  }
  return false;
}

function extractCodecInfo(parser) {
  let sps = null, pps = null;
  for (const au of parser.videoAccessUnits) {
    for (const nalUnit of au.nalUnits) {
      const nalType = nalUnit[0] & 0x1F;
      if (nalType === 7 && !sps) sps = nalUnit;
      if (nalType === 8 && !pps) pps = nalUnit;
      if (sps && pps) return { sps, pps };
    }
  }
  return { sps, pps };
}

/**
 * Parse a TS segment and return the parsed data.
 */
function parseTs(tsData) {
  const parser = new TSParser();
  parser.parse(tsData);
  parser.finalize();
  return parser;
}

/**
 * Remux parsed TS data into an fMP4 fragment.
 * Normalizes timestamps to start at the given base times.
 */
function remuxToFragment(parser, sequenceNumber, videoBaseTime, audioBaseTime, audioTimescale) {
  return createFragment({
    videoSamples: parser.videoAccessUnits,
    audioSamples: parser.audioAccessUnits,
    sequenceNumber,
    videoTimescale: PTS_PER_SECOND,
    audioTimescale,
    videoBaseTime,
    audioBaseTime,
    audioSampleDuration: 1024,
  });
}

/**
 * Clip a parsed TS segment at the start and/or end.
 *
 * Uses smart rendering when clipping at the start: re-encodes the
 * boundary GOP so the segment starts with a new keyframe at the
 * exact requested time. No preroll, no edit list, frame-accurate.
 *
 * @param {TSParser} parser - Parsed TS segment
 * @param {number} [startTime] - Start time in seconds (relative to segment)
 * @param {number} [endTime] - End time in seconds (relative to segment)
 * @param {object} [options]
 * @param {number} [options.qp=20] - Encoding quality for smart-rendered frames
 */
function clipSegment(parser, startTime, endTime, options = {}) {
  const { qp = 20 } = options;
  const startPts = (startTime !== undefined ? startTime : 0) * PTS_PER_SECOND;
  const endPts = (endTime !== undefined ? endTime : Infinity) * PTS_PER_SECOND;
  const videoAUs = parser.videoAccessUnits;
  const audioAUs = parser.audioAccessUnits;

  if (videoAUs.length === 0) return null;

  // Check if startTime falls between keyframes (needs smart rendering)
  let keyframeIdx = 0;
  for (let i = 0; i < videoAUs.length; i++) {
    if (videoAUs[i].pts > startPts) break;
    if (isKeyframe(videoAUs[i])) keyframeIdx = i;
  }

  let targetIdx = keyframeIdx;
  for (let i = keyframeIdx; i < videoAUs.length; i++) {
    if (videoAUs[i].pts >= startPts) { targetIdx = i; break; }
  }

  const needsSmartRender = startTime !== undefined && targetIdx > keyframeIdx;

  let clippedVideo, clippedAudio, startOffset;

  if (needsSmartRender) {
    // Smart render: re-encode boundary GOP for frame-accurate start
    const result = smartRender(parser, startTime, { endTime, qp });
    clippedVideo = result.videoAUs;
    startOffset = result.videoAUs.length > 0 ? result.videoAUs[0].pts : 0;

    // Clip audio to match smart-rendered video
    const audioEnd = endPts < Infinity ? Math.min(endPts, videoAUs[videoAUs.length - 1].pts + PTS_PER_SECOND) : Infinity;
    clippedAudio = audioAUs.filter(au => au.pts >= startOffset && au.pts < audioEnd);
  } else {
    // Start is at a keyframe — no smart rendering needed
    let endIdx = videoAUs.length;
    for (let i = keyframeIdx; i < videoAUs.length; i++) {
      if (videoAUs[i].pts >= endPts) { endIdx = i; break; }
    }

    clippedVideo = videoAUs.slice(keyframeIdx, endIdx);
    if (clippedVideo.length === 0) return null;
    startOffset = clippedVideo[0].pts;

    const lastVideoPts = clippedVideo[clippedVideo.length - 1].pts;
    const audioEndPts = Math.min(endPts, lastVideoPts + PTS_PER_SECOND);
    clippedAudio = audioAUs.filter(au => au.pts >= startOffset && au.pts < audioEndPts);
  }

  if (clippedVideo.length === 0) return null;

  // Normalize timestamps to start at 0
  for (const au of clippedVideo) { au.pts -= startOffset; au.dts -= startOffset; }
  for (const au of clippedAudio) { au.pts -= startOffset; }

  // Duration from actual content
  const duration = clippedVideo.length > 1
    ? clippedVideo[clippedVideo.length - 1].dts - clippedVideo[0].dts +
      (clippedVideo.length > 1 ? clippedVideo[1].dts - clippedVideo[0].dts : 3003)
    : 3003;

  return {
    videoSamples: clippedVideo,
    audioSamples: clippedAudio,
    duration: duration / PTS_PER_SECOND,
    smartRendered: needsSmartRender,
  };
}

// ── HlsClipResult ─────────────────────────────────────────

class HlsClipResult {
  constructor({ variants, duration, startTime, endTime }) {
    this._variants = variants; // array of VariantClip
    this.duration = duration;
    this.startTime = startTime;
    this.endTime = endTime;
  }

  /** Number of quality variants */
  get variantCount() {
    return this._variants.length;
  }

  /** Master playlist m3u8 text */
  get masterPlaylist() {
    if (this._variants.length === 1) {
      return this.getMediaPlaylist(0);
    }
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
   * Get CMAF media playlist for a variant.
   * @param {number} variantIndex
   * @returns {string} m3u8 text
   */
  getMediaPlaylist(variantIndex = 0) {
    const variant = this._variants[variantIndex];
    if (!variant) throw new Error(`Variant ${variantIndex} not found`);

    const maxDur = Math.max(...variant.segments.map(s => s.duration));

    let m3u8 = '#EXTM3U\n';
    m3u8 += '#EXT-X-VERSION:7\n';
    m3u8 += `#EXT-X-TARGETDURATION:${Math.ceil(maxDur)}\n`;
    m3u8 += '#EXT-X-PLAYLIST-TYPE:VOD\n';
    m3u8 += '#EXT-X-MEDIA-SEQUENCE:0\n';
    m3u8 += `#EXT-X-MAP:URI="init-${variantIndex}.m4s"\n`;

    for (let i = 0; i < variant.segments.length; i++) {
      const seg = variant.segments[i];
      m3u8 += `#EXTINF:${seg.duration.toFixed(6)},\n`;
      m3u8 += `segment-${variantIndex}-${i}.m4s\n`;
    }
    m3u8 += '#EXT-X-ENDLIST\n';
    return m3u8;
  }

  /**
   * Get the CMAF init segment for a variant.
   * @param {number} variantIndex
   * @returns {Uint8Array}
   */
  getInitSegment(variantIndex = 0) {
    return this._variants[variantIndex]?.initSegment ?? null;
  }

  /**
   * Get a media segment as fMP4 data.
   * Boundary segments are returned from memory (pre-clipped).
   * Middle segments are fetched from CDN and remuxed on-demand.
   *
   * @param {number} variantIndex
   * @param {number} segmentIndex
   * @returns {Promise<Uint8Array>}
   */
  async getSegment(variantIndex = 0, segmentIndex = 0) {
    const variant = this._variants[variantIndex];
    if (!variant) throw new Error(`Variant ${variantIndex} not found`);
    const seg = variant.segments[segmentIndex];
    if (!seg) throw new Error(`Segment ${segmentIndex} not found`);

    // Pre-clipped boundary segments are already in memory
    if (seg.data) return seg.data;

    // Middle segment: fetch from CDN, remux TS → fMP4
    const resp = await fetch(seg.originalUrl);
    if (!resp.ok) throw new Error(`Segment fetch failed: ${resp.status}`);
    const tsData = new Uint8Array(await resp.arrayBuffer());

    const parser = parseTs(tsData);
    const audioTimescale = parser.audioSampleRate || 48000;

    // Normalize timestamps: subtract the segment's original start PTS,
    // then add the segment's position in the clip timeline
    const firstVideoPts = parser.videoAccessUnits[0]?.pts ?? 0;
    for (const au of parser.videoAccessUnits) { au.pts -= firstVideoPts; au.dts -= firstVideoPts; }
    for (const au of parser.audioAccessUnits) { au.pts -= firstVideoPts; }

    const videoBaseTime = Math.round(seg.timelineOffset * PTS_PER_SECOND);
    const audioBaseTime = Math.round(seg.timelineOffset * audioTimescale);

    const fragment = remuxToFragment(
      parser, segmentIndex + 1,
      videoBaseTime, audioBaseTime, audioTimescale
    );

    return fragment;
  }

  /**
   * Get all segment data for a variant (fetches middle segments).
   * Useful for downloading the full clip.
   * @param {number} variantIndex
   * @returns {Promise<Uint8Array[]>}
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
 * Clip an HLS stream to a time range, producing a new HLS stream
 * with CMAF (fMP4) segments.
 *
 * @param {string} source - HLS URL (master or media playlist)
 * @param {object} options
 * @param {number} options.startTime - Start time in seconds
 * @param {number} options.endTime - End time in seconds
 * @param {string|number} [options.quality] - 'highest', 'lowest', or bandwidth (default: all)
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

  // Resolve variants to process
  let variantsToProcess = [];

  if (stream.isMaster) {
    const sorted = stream.qualities; // sorted by bandwidth desc
    if (quality === 'highest') {
      variantsToProcess = [sorted[0]];
    } else if (quality === 'lowest') {
      variantsToProcess = [sorted[sorted.length - 1]];
    } else if (typeof quality === 'number') {
      stream.select(quality);
      variantsToProcess = [stream.selected];
    } else {
      variantsToProcess = sorted; // all variants
    }
  } else {
    // Single media playlist — treat as one variant
    variantsToProcess = [{ url: null, bandwidth: 0, resolution: null, _segments: stream.segments, _initSegmentUrl: stream.initSegmentUrl }];
  }

  log(`Processing ${variantsToProcess.length} variant(s)...`);

  const variants = [];
  for (let vi = 0; vi < variantsToProcess.length; vi++) {
    const variant = variantsToProcess[vi];
    log(`Variant ${vi}: ${variant.resolution || variant.bandwidth || 'default'}`);

    // Get segment list for this variant
    let segments, initSegmentUrl;
    if (variant._segments) {
      segments = variant._segments;
      initSegmentUrl = variant._initSegmentUrl;
    } else {
      const mediaResp = await fetch(variant.url);
      if (!mediaResp.ok) throw new Error(`Failed to fetch media playlist: ${mediaResp.status}`);
      const mediaText = await mediaResp.text();
      const parsed = parsePlaylistText(mediaText, variant.url);
      segments = parsed.segments;
      initSegmentUrl = parsed.initSegmentUrl;
    }

    if (!segments.length) throw new Error('No segments found');

    // Find overlapping segments
    const overlapping = segments.filter(seg => seg.endTime > startTime && seg.startTime < endTime);
    if (!overlapping.length) throw new Error('No segments overlap the clip range');

    const firstSeg = overlapping[0];
    const lastSeg = overlapping[overlapping.length - 1];
    const isSingleSegment = overlapping.length === 1;

    log(`Segments: ${overlapping.length} (${firstSeg.startTime.toFixed(1)}s – ${lastSeg.endTime.toFixed(1)}s)`);

    // Download and parse boundary segments to get codec info + pre-clip
    log('Downloading boundary segments...');
    const firstTsData = new Uint8Array(await (await fetch(firstSeg.url)).arrayBuffer());
    const firstParser = parseTs(firstTsData);

    let lastParser = null;
    let lastTsData = null;
    if (!isSingleSegment) {
      lastTsData = new Uint8Array(await (await fetch(lastSeg.url)).arrayBuffer());
      lastParser = parseTs(lastTsData);
    }

    // Extract codec info from first segment
    const { sps, pps } = extractCodecInfo(firstParser);
    if (!sps || !pps) throw new Error('Could not extract SPS/PPS from video');
    const audioSampleRate = firstParser.audioSampleRate || 48000;
    const audioChannels = firstParser.audioChannels || 2;
    const hasAudio = firstParser.audioAccessUnits.length > 0;
    const audioTimescale = audioSampleRate;

    // Create CMAF init segment
    const initSegment = createInitSegment({
      sps, pps, audioSampleRate, audioChannels, hasAudio,
      videoTimescale: PTS_PER_SECOND,
      audioTimescale,
    });

    // Build the clip segment list
    const clipSegments = [];
    let timelineOffset = 0;

    // ── First segment (clipped at start, possibly also at end) ──
    // Convert absolute times to segment-relative times (TS PTS starts at ~0 per segment)
    const firstRelStart = startTime - firstSeg.startTime;
    const firstRelEnd = isSingleSegment ? endTime - firstSeg.startTime : undefined;
    const firstClipped = clipSegment(firstParser, firstRelStart, firstRelEnd);
    if (!firstClipped) throw new Error('First segment clip produced no samples');

    const firstFragment = createFragment({
      videoSamples: firstClipped.videoSamples,
      audioSamples: firstClipped.audioSamples,
      sequenceNumber: 1,
      videoTimescale: PTS_PER_SECOND,
      audioTimescale,
      videoBaseTime: 0,
      audioBaseTime: 0,
      audioSampleDuration: 1024,
    });

    clipSegments.push({
      duration: firstClipped.duration,
      data: firstFragment, // pre-clipped, in memory
      originalUrl: null,
      timelineOffset: 0,
      isBoundary: true,
    });
    timelineOffset += firstClipped.duration;

    // ── Middle segments (pass-through, remuxed on demand) ──
    for (let i = 1; i < overlapping.length - 1; i++) {
      const seg = overlapping[i];
      const segDuration = seg.duration;
      clipSegments.push({
        duration: segDuration,
        data: null, // fetched on demand
        originalUrl: seg.url,
        timelineOffset,
        isBoundary: false,
      });
      timelineOffset += segDuration;
    }

    // ── Last segment (clipped at end, if different from first) ──
    if (!isSingleSegment && lastParser) {
      const lastRelEnd = endTime - lastSeg.startTime;
      const lastClipped = clipSegment(lastParser, undefined, lastRelEnd);
      if (lastClipped && lastClipped.videoSamples.length > 0) {
        const lastDuration = lastClipped.duration;
        const lastSeqNum = overlapping.length;
        const lastVideoBaseTime = Math.round(timelineOffset * PTS_PER_SECOND);
        const lastAudioBaseTime = Math.round(timelineOffset * audioTimescale);

        const lastFragment = createFragment({
          videoSamples: lastClipped.videoSamples,
          audioSamples: lastClipped.audioSamples,
          sequenceNumber: lastSeqNum,
          videoTimescale: PTS_PER_SECOND,
          audioTimescale,
          videoBaseTime: lastVideoBaseTime,
          audioBaseTime: lastAudioBaseTime,
          audioSampleDuration: 1024,
        });

        clipSegments.push({
          duration: lastClipped.duration,
          data: lastFragment,
          originalUrl: null,
          timelineOffset,
          isBoundary: true,
        });
      }
    }

    const totalDuration = clipSegments.reduce((sum, s) => sum + s.duration, 0);
    log(`Clip ready: ${totalDuration.toFixed(2)}s (${clipSegments.length} segments)`);

    variants.push({
      bandwidth: variant.bandwidth || 0,
      resolution: variant.resolution || null,
      initSegment,
      segments: clipSegments,
    });
  }

  const clipDuration = endTime - startTime;
  return new HlsClipResult({
    variants,
    duration: clipDuration,
    startTime,
    endTime,
  });
}

export { HlsClipResult };
export default clipHls;
