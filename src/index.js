/**
 * toMp4.js - Convert MPEG-TS, fMP4, and HLS to standard MP4
 * Pure JavaScript, zero dependencies
 * 
 * @example
 * // From HLS URL (auto-selects highest quality)
 * const mp4 = await toMp4('https://example.com/stream.m3u8');
 * mp4.download('video.mp4');
 * 
 * // From segment URL
 * const mp4 = await toMp4('https://example.com/video.ts');
 * video.src = mp4.toURL();
 * 
 * // From raw data
 * const mp4 = await toMp4(uint8ArrayData);
 * 
 * // Advanced HLS: parse first, then select quality
 * const hls = await toMp4.parseHls('https://example.com/stream.m3u8');
 * console.log(hls.qualities); // Available qualities
 * const mp4 = await toMp4(hls.select('720p'));
 * 
 * ═══════════════════════════════════════════════════════════════
 * SUPPORTED (remuxing only - no transcoding)
 * ═══════════════════════════════════════════════════════════════
 * 
 * Containers:  MPEG-TS (.ts), fMP4 (.m4s), HLS (.m3u8)
 * Video:       H.264/AVC, H.265/HEVC
 * Audio:       AAC, AAC-LATM
 * 
 * NOT SUPPORTED: MPEG-1/2 Video, MP3, AC-3 (require transcoding)
 */

import { convertTsToMp4, analyzeTsData } from './ts-to-mp4.js';
import { convertFmp4ToMp4 } from './fmp4-to-mp4.js';
import { parseHls, downloadHls, isHlsUrl, HlsStream, HlsVariant } from './hls.js';

/**
 * Result object returned by toMp4()
 * Provides convenient methods to use the converted MP4 data
 */
class Mp4Result {
  /**
   * @param {Uint8Array} data - The MP4 data
   * @param {string} [filename] - Optional suggested filename
   */
  constructor(data, filename = 'video.mp4') {
    this.data = data;
    this.filename = filename;
    this._url = null;
    this._blob = null;
  }

  /** Size in bytes */
  get size() {
    return this.data.byteLength;
  }

  /** Size as human-readable string */
  get sizeFormatted() {
    const mb = this.data.byteLength / 1024 / 1024;
    return mb >= 1 ? `${mb.toFixed(2)} MB` : `${(this.data.byteLength / 1024).toFixed(1)} KB`;
  }

  /**
   * Get as Blob
   * @returns {Blob}
   */
  toBlob() {
    if (!this._blob) {
      this._blob = new Blob([this.data], { type: 'video/mp4' });
    }
    return this._blob;
  }

  /**
   * Get as object URL (for video.src, etc.)
   * @returns {string}
   */
  toURL() {
    if (!this._url) {
      this._url = URL.createObjectURL(this.toBlob());
    }
    return this._url;
  }

  /**
   * Revoke the object URL to free memory
   */
  revokeURL() {
    if (this._url) {
      URL.revokeObjectURL(this._url);
      this._url = null;
    }
  }

  /**
   * Download the MP4 file
   * @param {string} [filename] - Override the default filename
   */
  download(filename) {
    const a = document.createElement('a');
    a.href = this.toURL();
    a.download = filename || this.filename;
    a.click();
  }

  /**
   * Get as ArrayBuffer
   * @returns {ArrayBuffer}
   */
  toArrayBuffer() {
    return this.data.buffer.slice(this.data.byteOffset, this.data.byteOffset + this.data.byteLength);
  }
}

// ============================================
// Format Detection
// ============================================

function isMpegTs(data) {
  if (data.length < 4) return false;
  if (data[0] === 0x47) return true;
  for (let i = 0; i < Math.min(188, data.length); i++) {
    if (data[i] === 0x47 && i + 188 < data.length && data[i + 188] === 0x47) return true;
  }
  return false;
}

function isFmp4(data) {
  if (data.length < 8) return false;
  const type = String.fromCharCode(data[4], data[5], data[6], data[7]);
  return type === 'ftyp' || type === 'styp' || type === 'moof';
}

function isStandardMp4(data) {
  if (data.length < 12) return false;
  const type = String.fromCharCode(data[4], data[5], data[6], data[7]);
  if (type !== 'ftyp') return false;
  let offset = 0;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let hasMoov = false, hasMoof = false;
  while (offset + 8 <= data.length) {
    const size = view.getUint32(offset);
    if (size < 8) break;
    const boxType = String.fromCharCode(data[offset+4], data[offset+5], data[offset+6], data[offset+7]);
    if (boxType === 'moov') hasMoov = true;
    if (boxType === 'moof') hasMoof = true;
    offset += size;
  }
  return hasMoov && !hasMoof;
}

function detectFormat(data) {
  if (isMpegTs(data)) return 'mpegts';
  if (isStandardMp4(data)) return 'mp4';
  if (isFmp4(data)) return 'fmp4';
  return 'unknown';
}

// ============================================
// Core Conversion
// ============================================

function convertData(data, options = {}) {
  const uint8 = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const format = detectFormat(uint8);
  
  switch (format) {
    case 'mpegts':
      return convertTsToMp4(uint8, options);
    case 'fmp4':
      return convertFmp4ToMp4(uint8);
    case 'mp4':
      return uint8;
    default:
      throw new Error('Unrecognized video format. Expected MPEG-TS or fMP4.');
  }
}

// ============================================
// Main API
// ============================================

/**
 * Convert video to MP4
 * 
 * @param {string | Uint8Array | ArrayBuffer | Blob | HlsStream} input - URL, HLS stream, or video data
 * @param {object} [options] - Options
 * @param {function} [options.onProgress] - Progress callback
 * @param {string} [options.filename] - Suggested filename for downloads
 * @param {string|number} [options.quality] - HLS quality: 'highest', 'lowest', or bandwidth
 * @param {number} [options.maxSegments] - Max HLS segments to download (default: all)
 * @returns {Promise<Mp4Result>} - Result object with download(), toURL(), etc.
 * 
 * @example
 * // From HLS URL (auto-selects highest quality)
 * const mp4 = await toMp4('https://example.com/stream.m3u8');
 * mp4.download('my-video.mp4');
 * 
 * // From segment URL
 * const mp4 = await toMp4('https://example.com/video.ts');
 * 
 * // From data
 * const mp4 = await toMp4(uint8Array);
 * videoElement.src = mp4.toURL();
 * 
 * // Advanced: select specific quality
 * const hls = await toMp4.parseHls(url);
 * const mp4 = await toMp4(hls.select('lowest'));
 */
async function toMp4(input, options = {}) {
  let data;
  let filename = options.filename || 'video.mp4';
  const log = options.onProgress || (() => {});
  
  // Handle HlsStream object
  if (input instanceof HlsStream) {
    if (!options.filename) {
      const urlPart = (input.masterUrl || '').split('/').pop()?.split('?')[0];
      filename = urlPart ? urlPart.replace('.m3u8', '.mp4') : 'video.mp4';
    }
    data = await downloadHls(input, { 
      ...options,
      quality: options.quality || 'highest'
    });
  }
  // Handle URL strings
  else if (typeof input === 'string') {
    // Check if it's an HLS URL
    if (isHlsUrl(input)) {
      if (!options.filename) {
        const urlPart = input.split('/').pop()?.split('?')[0];
        filename = urlPart ? urlPart.replace('.m3u8', '.mp4') : 'video.mp4';
      }
      data = await downloadHls(input, {
        ...options,
        quality: options.quality || 'highest'
      });
    } else {
      // Regular URL - fetch it directly
      log('Fetching...');
      const response = await fetch(input);
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
      }
      data = new Uint8Array(await response.arrayBuffer());
      
      if (!options.filename) {
        const urlFilename = input.split('/').pop()?.split('?')[0];
        if (urlFilename) {
          filename = urlFilename.replace(/\.(ts|m4s)$/i, '') + '.mp4';
        }
      }
    }
  }
  // Handle Blob
  else if (input instanceof Blob) {
    data = new Uint8Array(await input.arrayBuffer());
  }
  // Handle ArrayBuffer
  else if (input instanceof ArrayBuffer) {
    data = new Uint8Array(input);
  }
  // Handle Uint8Array
  else if (input instanceof Uint8Array) {
    data = input;
  }
  else {
    throw new Error('Input must be a URL string, HlsStream, Uint8Array, ArrayBuffer, or Blob');
  }
  
  // Convert
  log('Converting...');
  const mp4Data = convertData(data, options);
  
  return new Mp4Result(mp4Data, filename);
}

// Attach utilities to main function
toMp4.fromTs = (data, options) => new Mp4Result(convertTsToMp4(data instanceof ArrayBuffer ? new Uint8Array(data) : data, options));
toMp4.fromFmp4 = (data) => new Mp4Result(convertFmp4ToMp4(data instanceof ArrayBuffer ? new Uint8Array(data) : data));
toMp4.detectFormat = detectFormat;
toMp4.isMpegTs = isMpegTs;
toMp4.isFmp4 = isFmp4;
toMp4.isStandardMp4 = isStandardMp4;

// HLS utilities
toMp4.parseHls = parseHls;
toMp4.downloadHls = downloadHls;
toMp4.isHlsUrl = isHlsUrl;

// Analysis utilities
toMp4.analyze = analyzeTsData;

// Version (injected at build time for dist, read from package.json for ESM)
toMp4.version = '1.0.3';

// Export
export { 
  toMp4, 
  Mp4Result, 
  convertTsToMp4, 
  convertFmp4ToMp4, 
  analyzeTsData,
  detectFormat, 
  isMpegTs, 
  isFmp4, 
  isStandardMp4,
  parseHls,
  downloadHls,
  isHlsUrl,
  HlsStream,
  HlsVariant
};
export default toMp4;
