/**
 * Remote MP4 → HLS
 *
 * Package a remote (progressive) MP4 as HLS on demand, using byte-range
 * requests: only the index (moov) is fetched up front; each MPEG-TS segment
 * fetches just the samples it needs.
 *
 * @example
 * import { RemoteMp4 } from 'tomp4';
 *
 * const source = await RemoteMp4.fromUrl('https://example.com/video.mp4');
 * const master = source.getMasterPlaylist();
 * const media = source.getMediaPlaylist('', { segmentName: i => `video-${i + 1}.ts` });
 * const ts = await source.getSegment(0);
 *
 * Timing: MP4 edit lists (edts/elst) are applied, so audio and video keep the
 * sync the file was authored with (B-frame delay and AAC priming are usually
 * expressed as edits). Segments are cut at keyframes and stay under
 * `segmentDuration`, or with `segmentBoundary: 'after'` end at the first
 * keyframe at or after it (ffmpeg's hls_time).
 *
 * Errors are RemoteMp4Error with an HTTP-style `status` and a `code` that
 * mirrors Fastly On-the-Fly Packager's X-Fastly-Package-Error values
 * ("Origin 404", "Origin timeout", "Invalid response from origin", …).
 *
 * @module remote
 */

import {
  readUint32, readUint64, boxType,
  analyzeTrack, buildSampleTable, buildSegments, findBox
} from '../parsers/mp4.js';

import { TSMuxer } from '../muxers/mpegts.js';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_SEGMENT_DURATION = 4;    // seconds
const DEFAULT_TIMEOUT_MS = 30000;      // per origin request, whole body
const DEFAULT_RETRIES = 2;             // network errors / 5xx only
const PROBE_SIZE = 256 * 1024;         // first read: ftyp + (usually) moov start
const COALESCE_GAP = 512 * 1024;       // merge sample ranges closer than this
const PTS_HZ = 90000;
const TS_PACKET = 188;

// ============================================================================
// Errors
// ============================================================================

/**
 * Error with an HTTP-style status. `code` mirrors OTFP's X-Fastly-Package-Error.
 */
export class RemoteMp4Error extends Error {
  constructor(code, { status = 500, detail, cause, retryable = false } = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'RemoteMp4Error';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

const corrupt = (detail) => new RemoteMp4Error('Incompatible or corrupt origin media', { status: 500, detail });

// ============================================================================
// Origin fetching
// ============================================================================

const CONTENT_RANGE_RE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/;

/** Read a response body, stopping once it exceeds `limit` bytes. */
async function readBody(res, limit) {
  if (!res.body?.getReader) {
    const data = new Uint8Array(await res.arrayBuffer());
    return { data, overflow: data.length > limit };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let length = 0;
  let overflow = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
    if (length > limit) {
      overflow = true;
      await reader.cancel().catch(() => { });
      break;
    }
  }
  const data = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { data.set(chunk, at); at += chunk.length; }
  return { data, overflow };
}

/**
 * Range reader for one origin URL: timeouts, retries on transient failures,
 * Content-Range validation and ETag pinning (a changed ETag mid-session means
 * the file was replaced — OTFP's "Flapping origin entity").
 *
 * Cross-origin responses hide Content-Range and ETag unless the origin lists
 * them in Access-Control-Expose-Headers. Without Content-Range the body
 * length is checked instead and the file size comes from a HEAD request
 * (Content-Length is always readable); without ETag, pinning is off.
 */
function createRangeReader(url, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const extraHeaders = options.headers || {};
  const state = { etag: null, lastModified: null, total: null };

  function checkUrl() {
    try {
      new URL(url, globalThis.location?.href);
    } catch {
      throw new RemoteMp4Error('Invalid origin URL', { status: 400, detail: String(url) });
    }
  }

  function pinEntity(res) {
    const etag = res.headers.get('etag');
    if (etag) {
      const strong = etag.replace(/^W\//, '');
      if (state.etag && strong !== state.etag) throw new RemoteMp4Error('Flapping origin entity', { status: 500 });
      state.etag = strong;
    }
    state.lastModified = state.lastModified || res.headers.get('last-modified');
  }

  /** One request. Error exits abort it, so an unread body never holds the connection. */
  async function request(method, start, end) {
    checkUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let ok = false;
    const failed = (err) => {
      if (controller.signal.aborted) return new RemoteMp4Error('Origin timeout', { status: 504, cause: err });
      return new RemoteMp4Error('Failed to reach origin', { status: 502, detail: err.message, cause: err, retryable: true });
    };
    try {
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers: method === 'GET' ? { ...extraHeaders, Range: `bytes=${start}-${end}` } : extraHeaders,
          signal: controller.signal,
        });
      } catch (err) {
        throw failed(err);
      }

      if (res.status === 404) throw new RemoteMp4Error('Origin 404', { status: 404, detail: 'HTTP 404' });
      if (res.status >= 500) {
        throw new RemoteMp4Error('Invalid response from origin', { status: 502, detail: `HTTP ${res.status}`, retryable: true });
      }

      if (method === 'HEAD') {
        if (res.status !== 200) throw new RemoteMp4Error('Invalid response from origin', { status: 502, detail: `HTTP ${res.status}` });
        pinEntity(res);
        ok = true;
        const length = Number(res.headers.get('content-length'));
        return length > 0 ? length : null;
      }

      const requested = end - start + 1;
      let total = null;
      if (res.status === 206) {
        const header = res.headers.get('content-range');
        if (header) {
          const m = CONTENT_RANGE_RE.exec(header);
          if (!m || Number(m[1]) !== start) {
            throw new RemoteMp4Error('Invalid Content-Range from origin', { status: 502 });
          }
          total = m[3] === '*' ? null : Number(m[3]);
        }
      } else if (res.status === 200 && start === 0) {
        // Range ignored: a 200 is the whole file, usable only when it fits the request.
        if (Number(res.headers.get('content-length')) > requested) {
          throw new RemoteMp4Error('Invalid response from origin', { status: 502, detail: 'origin ignored Range' });
        }
      } else {
        throw new RemoteMp4Error('Invalid response from origin', { status: 502, detail: `HTTP ${res.status}` });
      }
      pinEntity(res);

      let body;
      try {
        body = await readBody(res, requested);
      } catch (err) {
        throw failed(err);
      }
      const { data, overflow } = body;
      if (overflow) {
        throw new RemoteMp4Error('Invalid response from origin', {
          status: 502, detail: res.status === 200 ? 'origin ignored Range' : 'more bytes than requested',
        });
      }
      if (res.status === 200) total = data.length;                       // the whole file
      else if (total === null && data.length < requested) total = start + data.length; // range ran past EOF
      const expected = Math.min(end, (total ?? Infinity) - 1) - start + 1;
      if (data.length < expected) throw new RemoteMp4Error('Unexpected EOF on origin fetch', { status: 500 });
      if (total !== null) state.total = total;
      ok = true;
      return { data, total };
    } finally {
      clearTimeout(timer);
      if (!ok) controller.abort();
    }
  }

  async function withRetries(fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!err.retryable || attempt >= retries) throw err;
        await new Promise(r => setTimeout(r, 200 * (attempt + 1) ** 2));
      }
    }
  }

  return {
    /** Bytes [start, end]; `total` is the file size when the origin reported it. */
    range: (start, end) => withRetries(() => request('GET', start, end)),
    /** File size from a HEAD request (null when the origin doesn't send it). */
    size: () => withRetries(() => request('HEAD', 0, 0)),
    state,
  };
}

// ============================================================================
// AAC / H.264 helpers
// ============================================================================

const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000,
  22050, 16000, 12000, 11025, 8000, 7350];

/**
 * Wrap a raw AAC frame in an ADTS header.
 * @param {Uint8Array} aacData
 * @param {{objectType:number, samplingFrequencyIndex:number, channelConfiguration:number}} cfg
 */
export function wrapADTS(aacData, cfg) {
  // ADTS can carry object types 1–4 (profile = type - 1). HE-AAC (5/29) is
  // signalled implicitly: LC at the core rate, decoders find the SBR data.
  const objectType = cfg.objectType >= 1 && cfg.objectType <= 4 ? cfg.objectType : 2;
  const sfIndex = cfg.samplingFrequencyIndex;
  const channels = cfg.channelConfiguration;
  const frameLength = aacData.length + 7;

  const adts = new Uint8Array(frameLength);
  adts[0] = 0xFF;
  adts[1] = 0xF1;
  adts[2] = ((objectType - 1) << 6) | (sfIndex << 2) | ((channels >> 2) & 0x01);
  adts[3] = ((channels & 0x03) << 6) | ((frameLength >> 11) & 0x03);
  adts[4] = (frameLength >> 3) & 0xFF;
  adts[5] = ((frameLength & 0x07) << 5) | 0x1F;
  adts[6] = 0xFC;
  adts.set(aacData, 7);
  return adts;
}

const hex2 = (n) => n.toString(16).padStart(2, '0');

/** RFC 6381 codec string for H.264 from an SPS NAL (avc1.PPCCLL). */
function avcCodecString(sps) {
  return sps && sps.length >= 4 ? `avc1.${hex2(sps[1])}${hex2(sps[2])}${hex2(sps[3])}` : 'avc1.42e01e';
}

/** TS packets for one PES; the first packet carries `firstCapacity` bytes. */
function tsPackets(pesLength, firstCapacity) {
  return pesLength <= firstCapacity ? 1 : 1 + Math.ceil((pesLength - firstCapacity) / 184);
}

/** First index in sorted `arr` (length n) with arr[i] >= value. */
function lowerBound(arr, n, value) {
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// ============================================================================
// RemoteMp4
// ============================================================================

/**
 * Remote MP4 source with on-demand HLS (MPEG-TS) segment generation.
 */
export class RemoteMp4 {
  /**
   * @param {string} url - URL of the MP4 (origin must support Range requests)
   * @param {object} [options]
   * @param {number} [options.segmentDuration=4] - Target segment duration (s)
   * @param {'before'|'after'} [options.segmentBoundary='before'] - Cut segments
   *   before the target, or at the first keyframe after it (ffmpeg's hls_time)
   * @param {number} [options.timeoutMs=30000] - Per-request origin timeout
   * @param {number} [options.retries=2] - Retries for network errors / 5xx
   * @param {Record<string,string>} [options.headers] - Extra origin request headers
   * @param {typeof fetch} [options.fetch] - fetch implementation (tests)
   * @param {(msg:string)=>void} [options.onProgress]
   * @returns {Promise<RemoteMp4>}
   */
  static async fromUrl(url, options = {}) {
    const instance = new RemoteMp4(url, options);
    await instance._init();
    return instance;
  }

  constructor(url, options = {}) {
    this.url = url;
    this.segmentDuration = options.segmentDuration || DEFAULT_SEGMENT_DURATION;
    this.segmentBoundary = options.segmentBoundary === 'after' ? 'after' : 'before';
    this.onProgress = options.onProgress || (() => { });
    this._reader = createRangeReader(url, options);

    // Populated by _init()
    this.fileSize = 0;
    this.moov = null;
    this.videoTrack = null;  // analyzeTrack() results
    this.audioTrack = null;
    this.duration = 0;
    this.width = 0;
    this.height = 0;
    this.frameRate = 0;
    this.hasAudio = false;
    this.hasBframes = false;
    this.segments = [];
    this.codecs = '';
    this.bandwidth = 0;
    this.averageBandwidth = 0;
    this.etag = null;
    this.lastModified = null;

    this._video = null;  // compact sample table, presentation timeline
    this._audio = null;
    this._sps = null;
    this._pps = null;
    this._nalLengthSize = 4;
    this._aac = null;
    this._tsOffset = 0;   // seconds added so every TS timestamp is >= 0
    this._edits = null;
    this._videoSamples = null;  // object tables, built on first access
    this._audioSamples = null;
  }

  async _init() {
    this.onProgress('Fetching metadata...');

    const probe = await this._reader.range(0, PROBE_SIZE - 1);
    const fileSize = probe.total ?? await this._reader.size();
    if (!fileSize) {
      throw new RemoteMp4Error('Invalid response from origin', { status: 502, detail: 'file size unknown (no Content-Range or Content-Length)' });
    }
    this.fileSize = fileSize;
    const moov = await this._findMoov(probe.data);
    this.moov = moov;

    let videoTrack = null;
    let audioTrack = null;
    let trackOffset = 8;
    while (trackOffset < moov.length) {
      const trak = findBox(moov, 'trak', trackOffset);
      if (!trak) break;
      const track = analyzeTrack(moov, trak.offset, trak.size);
      if (track?.type === 'vide' && !videoTrack) videoTrack = track;
      else if (track?.type === 'soun' && !audioTrack) audioTrack = track;
      trackOffset = trak.offset + trak.size;
    }

    if (!videoTrack) throw corrupt('no video track');
    this.videoTrack = videoTrack;
    this.audioTrack = audioTrack;
    if (!videoTrack.codecConfig?.sps?.length || !videoTrack.codecConfig?.pps?.length) {
      throw new RemoteMp4Error('Unsupported video codec', { status: 500, detail: 'H.264 (avc1) only' });
    }
    if (videoTrack.stsz.length === 0) {
      throw new RemoteMp4Error('No audio/video samples found. Fragmented or malformed MP4 detected.', { status: 500 });
    }
    this._sps = videoTrack.codecConfig.sps[0];
    this._pps = videoTrack.codecConfig.pps[0];
    this._nalLengthSize = videoTrack.codecConfig.nalLengthSize || 4;
    this.width = videoTrack.width;
    this.height = videoTrack.height;
    this.hasBframes = videoTrack.ctts?.length > 0;

    // Presentation time = media time - shift (edit list). A positive shift
    // trims the start (B-frame delay, AAC priming); empty edits delay it.
    const vShift = videoTrack.edit.mediaTime - videoTrack.edit.emptyDuration;
    const vSamples = buildSampleTable(videoTrack).filter(s => s.offset + s.size <= this.fileSize);
    if (vSamples.length === 0) throw corrupt('no video samples');

    let aSamples = [];
    let aShift = 0;
    if (audioTrack) {
      const cfg = audioTrack.audioConfig;
      if (!cfg || (cfg.objectTypeIndication !== undefined && !cfg.asc)) {
        throw new RemoteMp4Error('Unsupported audio codec', { status: 500, detail: 'AAC (mp4a) only' });
      }
      const asc = cfg.asc;
      const sampleRate = asc?.sampleRate || cfg.sampleRate || 44100;
      const sfIndex = asc && asc.samplingFrequencyIndex < 13
        ? asc.samplingFrequencyIndex
        : Math.max(0, AAC_SAMPLE_RATES.indexOf(sampleRate));
      this._aac = {
        objectType: asc?.objectType || 2,
        samplingFrequencyIndex: sfIndex,
        channelConfiguration: asc?.channelConfiguration || cfg.channels || 2,
      };
      aShift = audioTrack.edit.mediaTime - audioTrack.edit.emptyDuration;
      aSamples = buildSampleTable(audioTrack).filter(s => s.offset + s.size <= this.fileSize);
      this.hasAudio = aSamples.length > 0;
    }
    this._edits = { video: videoTrack.edit, audio: audioTrack?.edit ?? null };

    // Compact tables (typed arrays; the object tables are dropped after init).
    const nv = vSamples.length;
    const video = {
      count: nv,
      offset: new Float64Array(nv),
      size: new Uint32Array(nv),
      pts: new Float64Array(nv),
      dts: new Float64Array(nv),
      key: new Uint8Array(nv),
      duration: new Float64Array(nv),
    };
    const timeline = new Array(nv);
    let minTime = Infinity;
    let presentationEnd = -Infinity;
    for (let i = 0; i < nv; i++) {
      const s = vSamples[i];
      video.offset[i] = s.offset;
      video.size[i] = s.size;
      video.pts[i] = s.pts - vShift;
      video.dts[i] = s.dts - vShift;
      video.key[i] = s.isKeyframe ? 1 : 0;
      video.duration[i] = s.duration;
      minTime = Math.min(minTime, video.pts[i], video.dts[i]);
      presentationEnd = Math.max(presentationEnd, video.pts[i] + s.duration);
      timeline[i] = { time: video.pts[i], duration: s.duration, isKeyframe: s.isKeyframe };
    }

    const na = aSamples.length;
    const audio = {
      count: na,
      offset: new Float64Array(na),
      size: new Uint32Array(na),
      time: new Float64Array(na),
      duration: new Float64Array(na),
    };
    for (let i = 0; i < na; i++) {
      const s = aSamples[i];
      audio.offset[i] = s.offset;
      audio.size[i] = s.size;
      audio.time[i] = s.dts - aShift;
      audio.duration[i] = s.duration;
      minTime = Math.min(minTime, audio.time[i]);
    }
    this._video = video;
    this._audio = audio;
    this._tsOffset = Math.max(0, -minTime);

    // Segments in presentation time; video positions from buildSegments,
    // audio assigned by presentation time so no sample is dropped or doubled
    // (first segment takes everything before it, last everything after).
    const segments = buildSegments(timeline, this.segmentDuration, { boundary: this.segmentBoundary });
    if (segments.length === 0) {
      throw new RemoteMp4Error('Video track has no key frames', { status: 500 });
    }
    // MPEG-TS bytes per segment, the way TSMuxer packs them: video access
    // units get an AUD (+ SPS/PPS on keyframes, with PAT/PMT before them) in a
    // PES whose first packet carries a PCR; each AAC frame gets an ADTS
    // header and its own PES.
    const lenSize = this._nalLengthSize;
    const keyExtra = 8 + this._sps.length + this._pps.length;
    for (let k = 0; k < segments.length; k++) {
      const seg = segments[k];
      seg.audioStart = k === 0 ? 0 : lowerBound(audio.time, na, seg.startTime);
      seg.audioEnd = k === segments.length - 1 ? na : lowerBound(audio.time, na, segments[k + 1].startTime);
      let packets = 0;
      for (let i = seg.videoStart; i < seg.videoEnd; i++) {
        const key = video.key[i] === 1;
        // Annex B start codes replace the length prefixes (4 bytes each; one NAL assumed when shorter)
        const annexB = 6 + (key ? keyExtra : 0) + video.size[i] + Math.max(0, 4 - lenSize);
        const header = video.pts[i] === video.dts[i] ? 14 : 19;
        packets += tsPackets(header + annexB, 176) + (key ? 2 : 0);
      }
      for (let i = seg.audioStart; i < seg.audioEnd; i++) packets += tsPackets(14 + 7 + audio.size[i], 184);
      seg.tsBytes = packets * TS_PACKET;
    }
    this.segments = segments;
    this.duration = presentationEnd;

    // Stream attributes for the master playlist. BANDWIDTH is the peak over
    // runs of contiguous segments lasting 0.5–1.5× the target duration
    // (RFC 8216 §4.3.4.2); a single longer segment counts on its own.
    const target = this.segmentDuration;
    let peak = 0, totalBytes = 0;
    for (const seg of segments) totalBytes += seg.tsBytes;
    for (let i = 0; i < segments.length; i++) {
      let bytes = 0, seconds = 0;
      for (let j = i; j < segments.length; j++) {
        bytes += segments[j].tsBytes;
        seconds += segments[j].duration;
        if (seconds >= 0.5 * target) {
          if (seconds <= 1.5 * target || j === i) peak = Math.max(peak, (bytes * 8) / seconds);
          break;
        }
      }
    }
    const playDuration = presentationEnd - segments[0].startTime;
    this.averageBandwidth = Math.ceil((totalBytes * 8) / Math.max(playDuration, 0.001));
    this.bandwidth = Math.max(this.averageBandwidth, Math.ceil(peak));
    this.frameRate = playDuration > 0 ? Math.round((nv / playDuration) * 1000) / 1000 : 0;
    const aot = this._aac?.objectType;
    const audioCodec = this.hasAudio ? `mp4a.40.${aot === 5 || aot === 29 ? aot : 2}` : null;
    this.codecs = [avcCodecString(this._sps), audioCodec].filter(Boolean).join(',');

    this.etag = this._reader.state.etag;
    this.lastModified = this._reader.state.lastModified;

    this.onProgress(`Parsed: ${this.duration.toFixed(1)}s, ${this.segments.length} segments`);
  }

  /** Walk top-level boxes to the moov (start or end of file), fetching only what's needed. */
  async _findMoov(head) {
    let offset = 0;
    while (offset + 8 <= this.fileSize) {
      let hdr;
      if (offset + 16 <= head.length) {
        hdr = head.subarray(offset, offset + 16);
      } else {
        hdr = (await this._reader.range(offset, Math.min(offset + 15, this.fileSize - 1))).data;
      }
      if (hdr.length < 8) break;
      let size = readUint32(hdr, 0);
      const type = boxType(hdr, 4);
      if (size === 1) size = hdr.length >= 16 ? readUint64(hdr, 8) : 0;
      else if (size === 0) size = this.fileSize - offset;
      if (size < 8) break;

      if (type === 'moov') {
        if (offset + size <= head.length) return head.slice(offset, offset + size);
        const moov = new Uint8Array(size);
        const have = Math.max(0, head.length - offset);
        if (have > 0) moov.set(head.subarray(offset, offset + have), 0);
        const rest = await this._reader.range(offset + have, offset + size - 1);
        moov.set(rest.data, have);
        return moov;
      }
      if (type === 'moof') {
        throw new RemoteMp4Error('No audio/video samples found. Fragmented or malformed MP4 detected.', { status: 500 });
      }
      offset += size;
    }
    throw corrupt('no moov box');
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  getInfo() {
    return {
      url: this.url,
      fileSize: this.fileSize,
      duration: this.duration,
      width: this.width,
      height: this.height,
      frameRate: this.frameRate,
      codecs: this.codecs,
      bandwidth: this.bandwidth,
      averageBandwidth: this.averageBandwidth,
      hasAudio: this.hasAudio,
      hasBframes: this.hasBframes,
      segmentCount: this.segments.length,
      videoSampleCount: this._video?.count ?? 0,
      audioSampleCount: this._audio?.count ?? 0,
      keyframeCount: this._video ? this._video.key.reduce((n, k) => n + k, 0) : 0,
      edits: this._edits,
      etag: this.etag,
    };
  }

  /**
   * Video sample table (decode order, presentation-time seconds), built on
   * first access from the compact internal tables. Positions match
   * `segments[i].videoStart` / `videoEnd`.
   */
  get videoSamples() {
    const v = this._video;
    if (!v) return [];
    return this._videoSamples ??= Array.from({ length: v.count }, (_, i) => ({
      index: i, offset: v.offset[i], size: v.size[i], duration: v.duration[i],
      pts: v.pts[i], dts: v.dts[i], time: v.pts[i], isKeyframe: v.key[i] === 1,
    }));
  }

  /** Audio sample table (presentation-time seconds), built on first access. */
  get audioSamples() {
    const a = this._audio;
    if (!a) return [];
    return this._audioSamples ??= Array.from({ length: a.count }, (_, i) => ({
      index: i, offset: a.offset[i], size: a.size[i], duration: a.duration[i],
      pts: a.time[i], dts: a.time[i], time: a.time[i], isKeyframe: true,
    }));
  }

  getSegments() {
    return this.segments.map(s => ({
      index: s.index,
      startTime: s.startTime,
      endTime: s.endTime,
      duration: s.duration
    }));
  }

  /** `#EXT-X-STREAM-INF` attributes for this source (without the tag). */
  getStreamInfAttributes() {
    const attrs = [`BANDWIDTH=${this.bandwidth}`, `AVERAGE-BANDWIDTH=${this.averageBandwidth}`];
    if (this.codecs) attrs.push(`CODECS="${this.codecs}"`);
    if (this.width && this.height) attrs.push(`RESOLUTION=${Math.round(this.width)}x${Math.round(this.height)}`);
    if (this.frameRate) attrs.push(`FRAME-RATE=${this.frameRate.toFixed(3)}`);
    return attrs.join(',');
  }

  /**
   * Master playlist with a single variant.
   * @param {string} [baseUrl='']
   * @param {string} [variantUri='playlist.m3u8']
   */
  getMasterPlaylist(baseUrl = '', variantUri = 'playlist.m3u8') {
    return RemoteMp4.buildMasterPlaylist([{ source: this, uri: `${baseUrl}${variantUri}` }]);
  }

  /**
   * Master playlist for several renditions, in the order given.
   * @param {Array<{source: RemoteMp4, uri: string}>} variants
   */
  static buildMasterPlaylist(variants) {
    let out = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n';
    for (const { source, uri } of variants) {
      out += `#EXT-X-STREAM-INF:${source.getStreamInfAttributes()}\n${uri}\n`;
    }
    return out;
  }

  /**
   * Segments overlapping [start, end) seconds (presentation time); all when unset.
   */
  segmentsInRange(start, end) {
    const from = Number.isFinite(start) ? start : -Infinity;
    const to = Number.isFinite(end) ? end : Infinity;
    return this.segments.filter(s => s.endTime > from && s.startTime < to);
  }

  /**
   * Media playlist (VOD).
   * @param {string} [baseUrl=''] - Prefix for segment URIs
   * @param {object} [options]
   * @param {(index:number)=>string} [options.segmentName] - default `segment{index}.ts`
   * @param {number} [options.start] - Slice start (s)
   * @param {number} [options.end] - Slice end (s)
   */
  getMediaPlaylist(baseUrl = '', options = {}) {
    const name = options.segmentName || ((i) => `segment${i}.ts`);
    const segments = this.segmentsInRange(options.start, options.end);
    if (segments.length === 0) {
      throw new RemoteMp4Error('No segments in range', { status: 404, detail: `${options.start}-${options.end}` });
    }
    // EXTINF (as written) rounded to the nearest integer must be <= target
    // duration (RFC 8216 §4.3.3.1).
    let target = 1;
    for (const s of segments) target = Math.max(target, Math.round(Number(s.duration.toFixed(3))));
    let playlist = '#EXTM3U\n#EXT-X-VERSION:3\n'
      + `#EXT-X-TARGETDURATION:${target}\n`
      + `#EXT-X-MEDIA-SEQUENCE:${segments[0]?.index ?? 0}\n`
      + '#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n';
    for (const s of segments) {
      playlist += `#EXTINF:${s.duration.toFixed(3)},\n${baseUrl}${name(s.index)}\n`;
    }
    return playlist + '#EXT-X-ENDLIST\n';
  }

  /**
   * One segment as MPEG-TS.
   * @param {number} index
   * @returns {Promise<Uint8Array>}
   */
  async getSegment(index) {
    const seg = this.segments[index];
    if (!seg) {
      const err = new RemoteMp4Error('Segment not found', { status: 404, detail: String(index) });
      err.message = `Segment ${index} not found`;
      throw err;
    }

    const v = this._video, a = this._audio;
    const reads = [];
    for (let i = seg.videoStart; i < seg.videoEnd; i++) reads.push({ offset: v.offset[i], size: v.size[i] });
    for (let i = seg.audioStart; i < seg.audioEnd; i++) reads.push({ offset: a.offset[i], size: a.size[i] });
    const fetched = await this._readSamples(reads);

    const muxer = new TSMuxer();
    muxer.setSpsPps(this._sps, this._pps);
    muxer.setNalLengthSize(this._nalLengthSize);
    muxer.setHasAudio(this.hasAudio);

    const nVideo = seg.videoEnd - seg.videoStart;
    const off = this._tsOffset;
    for (let i = seg.audioStart, r = nVideo; i < seg.audioEnd; i++, r++) {
      muxer.addAudioSample(wrapADTS(fetched[r], this._aac), Math.round((a.time[i] + off) * PTS_HZ));
    }
    for (let i = seg.videoStart, r = 0; i < seg.videoEnd; i++, r++) {
      muxer.addVideoSample(
        fetched[r],
        v.key[i] === 1,
        Math.round((v.pts[i] + off) * PTS_HZ),
        Math.round((v.dts[i] + off) * PTS_HZ),
      );
    }
    muxer.flush();
    return muxer.build();
  }

  /**
   * Fetch sample payloads: one request when the samples sit together (the
   * usual interleaved file), coalesced ranges otherwise. Returns payloads in
   * the order of `reads`.
   */
  async _readSamples(reads) {
    if (reads.length === 0) return [];
    const order = reads.map((r, i) => i).sort((x, y) => reads[x].offset - reads[y].offset);
    const ranges = [];
    let cur = null;
    for (const i of order) {
      const { offset, size } = reads[i];
      if (cur && offset <= cur.end + COALESCE_GAP) {
        cur.end = Math.max(cur.end, offset + size);
        cur.members.push(i);
      } else {
        cur = { start: offset, end: offset + size, members: [i] };
        ranges.push(cur);
      }
    }

    const out = new Array(reads.length);
    await Promise.all(ranges.map(async (range) => {
      const { data } = await this._reader.range(range.start, range.end - 1);
      for (const i of range.members) {
        const rel = reads[i].offset - range.start;
        out[i] = data.subarray(rel, rel + reads[i].size);
      }
    }));
    return out;
  }
}

export default RemoteMp4;
