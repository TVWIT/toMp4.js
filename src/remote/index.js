/**
 * Remote MP4 Parser
 * 
 * Fetch and parse MP4 files remotely using byte-range requests.
 * Only downloads metadata (moov) upfront, then fetches segments on-demand.
 * 
 * @example
 * import { RemoteMp4 } from 'tomp4';
 * 
 * const source = await RemoteMp4.fromUrl('https://example.com/video.mp4');
 * 
 * // Get HLS playlists
 * const masterPlaylist = source.getMasterPlaylist();
 * const mediaPlaylist = source.getMediaPlaylist();
 * 
 * // Get a segment as MPEG-TS
 * const tsData = await source.getSegment(0);
 * 
 * @module remote
 */

import {
  readUint32, boxType, findBox,
  analyzeTrack, buildSampleTable, buildSegments, calculateByteRanges
} from '../parsers/mp4.js';

import { TSMuxer } from '../muxers/mpegts.js';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_SEGMENT_DURATION = 4; // seconds
const FETCH_TIMEOUT = 30000; // 30 seconds
const MAX_HEADER_SIZE = 256 * 1024; // 256KB for initial probe
const MAX_TAIL_SIZE = 2 * 1024 * 1024; // 2MB for moov at end

// ============================================================================
// Fetch Utilities
// ============================================================================

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Fetch timeout after ${FETCH_TIMEOUT}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRange(url, start, end) {
  const response = await fetchWithTimeout(url, {
    headers: { 'Range': `bytes=${start}-${end}` }
  });
  if (!response.ok && response.status !== 206) {
    throw new Error(`HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchFileSize(url) {
  const response = await fetchWithTimeout(url, { method: 'HEAD' });
  return parseInt(response.headers.get('content-length'), 10);
}

// ============================================================================
// ADTS Wrapper for AAC
// ============================================================================

function wrapADTS(aacData, sampleRate, channels) {
  const sampleRateIndex = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 
                           22050, 16000, 12000, 11025, 8000, 7350].indexOf(sampleRate);
  const frameLength = aacData.length + 7;
  
  const adts = new Uint8Array(7 + aacData.length);
  adts[0] = 0xFF;
  adts[1] = 0xF1;
  adts[2] = ((2 - 1) << 6) | ((sampleRateIndex < 0 ? 4 : sampleRateIndex) << 2) | ((channels >> 2) & 0x01);
  adts[3] = ((channels & 0x03) << 6) | ((frameLength >> 11) & 0x03);
  adts[4] = (frameLength >> 3) & 0xFF;
  adts[5] = ((frameLength & 0x07) << 5) | 0x1F;
  adts[6] = 0xFC;
  adts.set(aacData, 7);
  
  return adts;
}

// ============================================================================
// RemoteMp4 Class
// ============================================================================

/**
 * Remote MP4 source with on-demand HLS segment generation
 */
export class RemoteMp4 {
  /**
   * Create a RemoteMp4 instance from a URL
   * @param {string} url - URL to the MP4 file
   * @param {object} options - Options
   * @param {number} options.segmentDuration - Target segment duration (default 4s)
   * @param {function} options.onProgress - Progress callback
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
    this.onProgress = options.onProgress || (() => {});
    
    // Populated by _init()
    this.fileSize = 0;
    this.moov = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.videoSamples = [];
    this.audioSamples = [];
    this.segments = [];
    
    // Computed properties
    this.duration = 0;
    this.width = 0;
    this.height = 0;
    this.hasAudio = false;
    this.hasBframes = false;
  }
  
  async _init() {
    this.onProgress('Fetching metadata...');
    
    // Get file size
    this.fileSize = await fetchFileSize(this.url);
    
    // Find and fetch moov box
    this.moov = await this._findMoov();
    
    // Parse tracks using shared parser
    let trackOffset = 8;
    while (trackOffset < this.moov.length) {
      const trak = findBox(this.moov, 'trak', trackOffset);
      if (!trak) break;
      
      const track = analyzeTrack(this.moov, trak.offset, trak.size);
      if (track) {
        if (track.type === 'vide' && !this.videoTrack) {
          this.videoTrack = track;
          this.videoSamples = buildSampleTable(track);
          this.duration = track.durationSeconds;
          this.width = track.width;
          this.height = track.height;
          this.hasBframes = track.ctts && track.ctts.length > 0;
        } else if (track.type === 'soun' && !this.audioTrack) {
          this.audioTrack = track;
          this.audioSamples = buildSampleTable(track);
          this.hasAudio = true;
        }
      }
      trackOffset = trak.offset + trak.size;
    }
    
    if (!this.videoTrack) {
      throw new Error('No video track found');
    }
    
    // Build segments
    this.segments = buildSegments(this.videoSamples, this.segmentDuration);
    
    this.onProgress(`Parsed: ${this.duration.toFixed(1)}s, ${this.segments.length} segments`);
  }
  
  async _findMoov() {
    const headerSize = Math.min(MAX_HEADER_SIZE, this.fileSize);
    const header = await fetchRange(this.url, 0, headerSize - 1);
    
    // Scan header for boxes
    let offset = 0;
    while (offset < header.length - 8) {
      const size = readUint32(header, offset);
      const type = boxType(header, offset + 4);
      
      if (size === 0 || size > this.fileSize) break;
      
      if (type === 'moov') {
        // moov in header - fetch complete if needed
        if (offset + size <= header.length) {
          return header.slice(offset, offset + size);
        }
        return fetchRange(this.url, offset, offset + size - 1);
      }
      
      if (type === 'mdat') {
        // mdat at start means moov is at end
        const moovOffset = offset + size;
        if (moovOffset < this.fileSize) {
          const tailSize = Math.min(MAX_TAIL_SIZE, this.fileSize - moovOffset);
          const tail = await fetchRange(this.url, moovOffset, moovOffset + tailSize - 1);
          const moov = findBox(tail, 'moov');
          if (moov) {
            if (moov.size <= tail.length) {
              return tail.slice(moov.offset, moov.offset + moov.size);
            }
            return fetchRange(this.url, moovOffset + moov.offset, 
                            moovOffset + moov.offset + moov.size - 1);
          }
        }
        break;
      }
      
      offset += size;
    }
    
    // Try end of file as fallback
    const tailSize = Math.min(MAX_TAIL_SIZE, this.fileSize);
    const tail = await fetchRange(this.url, this.fileSize - tailSize, this.fileSize - 1);
    const moov = findBox(tail, 'moov');
    
    if (moov) {
      const moovStart = this.fileSize - tailSize + moov.offset;
      return fetchRange(this.url, moovStart, moovStart + moov.size - 1);
    }
    
    // Check for fragmented MP4
    const moof = findBox(header, 'moof');
    if (moof) {
      throw new Error('Fragmented MP4 (fMP4) not supported');
    }
    
    throw new Error('Could not find moov box');
  }
  
  // ===========================================================================
  // Public API
  // ===========================================================================
  
  /**
   * Get source information
   */
  getInfo() {
    return {
      url: this.url,
      fileSize: this.fileSize,
      duration: this.duration,
      width: this.width,
      height: this.height,
      hasAudio: this.hasAudio,
      hasBframes: this.hasBframes,
      segmentCount: this.segments.length,
      videoSampleCount: this.videoSamples.length,
      audioSampleCount: this.audioSamples.length,
      keyframeCount: this.videoTrack?.stss?.length || 0
    };
  }
  
  /**
   * Get segment definitions
   */
  getSegments() {
    return this.segments.map(s => ({
      index: s.index,
      startTime: s.startTime,
      endTime: s.endTime,
      duration: s.duration
    }));
  }
  
  /**
   * Generate HLS master playlist
   */
  getMasterPlaylist(baseUrl = '') {
    const bandwidth = Math.round(
      (this.videoSamples.reduce((s, v) => s + v.size, 0) / this.duration) * 8
    );
    
    const resolution = this.width && this.height ? 
      `,RESOLUTION=${this.width}x${this.height}` : '';
    
    return `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}${resolution}
${baseUrl}playlist.m3u8
`;
  }
  
  /**
   * Generate HLS media playlist
   */
  getMediaPlaylist(baseUrl = '') {
    let playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:${Math.ceil(this.segmentDuration)}
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
`;
    
    for (const segment of this.segments) {
      playlist += `#EXTINF:${segment.duration.toFixed(6)},\n${baseUrl}segment${segment.index}.ts\n`;
    }
    
    playlist += '#EXT-X-ENDLIST\n';
    return playlist;
  }
  
  /**
   * Get a segment as MPEG-TS data
   * @param {number} index - Segment index
   * @returns {Promise<Uint8Array>} MPEG-TS segment data
   */
  async getSegment(index) {
    const segment = this.segments[index];
    if (!segment) {
      throw new Error(`Segment ${index} not found`);
    }
    
    // Get samples for this segment
    const videoSamples = this.videoSamples.slice(segment.videoStart, segment.videoEnd);
    const audioSamples = this.audioSamples.filter(
      s => s.time >= segment.startTime && s.time < segment.endTime
    );
    
    // Fetch video data using byte ranges
    const videoRanges = calculateByteRanges(videoSamples);
    const videoData = await this._fetchRanges(videoRanges);
    
    // Map video sample data
    const parsedVideoSamples = videoSamples.map(sample => {
      const range = videoRanges.find(r => r.samples.includes(sample));
      const data = videoData.get(range);
      const relOffset = sample.offset - range.start;
      return {
        ...sample,
        data: data.slice(relOffset, relOffset + sample.size)
      };
    });
    
    // Fetch and map audio data
    let parsedAudioSamples = [];
    if (audioSamples.length > 0) {
      const audioRanges = calculateByteRanges(audioSamples);
      const audioData = await this._fetchRanges(audioRanges);
      
      parsedAudioSamples = audioSamples.map(sample => {
        const range = audioRanges.find(r => r.samples.includes(sample));
        const data = audioData.get(range);
        const relOffset = sample.offset - range.start;
        return {
          ...sample,
          data: data.slice(relOffset, relOffset + sample.size)
        };
      });
    }
    
    // Build MPEG-TS segment
    return this._buildTsSegment(parsedVideoSamples, parsedAudioSamples);
  }
  
  async _fetchRanges(ranges) {
    const results = new Map();
    
    // Fetch ranges in parallel
    await Promise.all(ranges.map(async range => {
      const data = await fetchRange(this.url, range.start, range.end - 1);
      results.set(range, data);
    }));
    
    return results;
  }
  
  _buildTsSegment(videoSamples, audioSamples) {
    const muxer = new TSMuxer();
    
    if (this.videoTrack?.codecConfig) {
      muxer.setSpsPps(
        this.videoTrack.codecConfig.sps[0],
        this.videoTrack.codecConfig.pps[0]
      );
    }
    
    muxer.setHasAudio(audioSamples.length > 0);
    
    const PTS_PER_SECOND = 90000;
    const sampleRate = this.audioTrack?.audioConfig?.sampleRate || 44100;
    const channels = this.audioTrack?.audioConfig?.channels || 2;
    
    // Add audio samples
    for (const sample of audioSamples) {
      const dts90k = Math.round((sample.dts ?? sample.time) * PTS_PER_SECOND);
      const adts = wrapADTS(sample.data, sampleRate, channels);
      muxer.addAudioSample(adts, dts90k);
    }
    
    // Add video samples with PTS and DTS
    for (const sample of videoSamples) {
      const pts90k = Math.round((sample.pts ?? sample.time) * PTS_PER_SECOND);
      const dts90k = Math.round((sample.dts ?? sample.time) * PTS_PER_SECOND);
      muxer.addVideoSample(sample.data, sample.isKeyframe, pts90k, dts90k);
    }
    
    muxer.flush();
    return muxer.build();
  }
}

export default RemoteMp4;
