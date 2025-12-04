/**
 * HLS Playlist Parser and Downloader
 * Handles master playlists, variant selection, and segment downloading
 */

/**
 * Represents a quality variant in an HLS stream
 */
class HlsVariant {
  constructor({ bandwidth, resolution, codecs, url, name }) {
    this.bandwidth = bandwidth;
    this.resolution = resolution;
    this.codecs = codecs;
    this.url = url;
    this.name = name || this._generateName();
  }

  _generateName() {
    if (this.resolution) return this.resolution;
    if (this.bandwidth) return `${Math.round(this.bandwidth / 1000)}kbps`;
    return 'unknown';
  }

  /** Bandwidth in kbps */
  get kbps() {
    return Math.round(this.bandwidth / 1000);
  }

  /** Bandwidth in Mbps */
  get mbps() {
    return (this.bandwidth / 1000000).toFixed(2);
  }
}

/**
 * Represents a parsed HLS stream with quality variants
 */
class HlsStream {
  constructor(masterUrl, variants, segments = null) {
    this.masterUrl = masterUrl;
    this.variants = variants;
    this.segments = segments;
    this._selectedVariant = null;
  }

  /** Whether this is a master playlist with multiple qualities */
  get isMaster() {
    return this.variants.length > 0;
  }

  /** Get all available qualities sorted by bandwidth (highest first) */
  get qualities() {
    return [...this.variants].sort((a, b) => b.bandwidth - a.bandwidth);
  }

  /** Get the highest quality variant */
  get highest() {
    return this.qualities[0] || null;
  }

  /** Get the lowest quality variant */
  get lowest() {
    const q = this.qualities;
    return q[q.length - 1] || null;
  }

  /** Currently selected variant */
  get selected() {
    return this._selectedVariant || this.highest;
  }

  /**
   * Select a quality variant
   * @param {string|number|HlsVariant} selector - 'highest', 'lowest', bandwidth number, or variant object
   * @returns {HlsStream} this for chaining
   */
  select(selector) {
    if (selector === 'highest') {
      this._selectedVariant = this.highest;
    } else if (selector === 'lowest') {
      this._selectedVariant = this.lowest;
    } else if (typeof selector === 'number') {
      // Find by bandwidth (closest match)
      this._selectedVariant = this.qualities.reduce((best, v) => 
        Math.abs(v.bandwidth - selector) < Math.abs(best.bandwidth - selector) ? v : best
      );
    } else if (selector instanceof HlsVariant) {
      this._selectedVariant = selector;
    } else if (typeof selector === 'string' && selector.includes('x')) {
      // Match by resolution string like "1920x1080"
      this._selectedVariant = this.variants.find(v => v.resolution === selector) || this.highest;
    }
    return this;
  }
}

/**
 * Convert relative URL to absolute
 */
function toAbsoluteUrl(relative, base) {
  if (relative.startsWith('http://') || relative.startsWith('https://')) {
    return relative;
  }
  return new URL(relative, base).href;
}

/**
 * Represents a segment with duration info
 */
class HlsSegment {
  constructor(url, duration, startTime) {
    this.url = url;
    this.duration = duration;
    this.startTime = startTime;
    this.endTime = startTime + duration;
  }
}

/**
 * Parse an HLS playlist text
 * @param {string} text - Playlist content
 * @param {string} baseUrl - Base URL for resolving relative paths
 * @returns {{ variants: HlsVariant[], segments: HlsSegment[] }}
 */
function parsePlaylistText(text, baseUrl) {
  const lines = text.split('\n').map(l => l.trim());
  const variants = [];
  const segments = [];
  let currentDuration = 0;
  let runningTime = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Parse master playlist variants
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = line.substring(18);
      const bandwidth = parseInt(attrs.match(/BANDWIDTH=(\d+)/)?.[1] || '0');
      const resolution = attrs.match(/RESOLUTION=(\d+x\d+)/)?.[1] || null;
      const codecs = attrs.match(/CODECS="([^"]+)"/)?.[1] || null;
      
      // Next non-comment line is the URL
      let urlLine = lines[i + 1];
      if (urlLine && !urlLine.startsWith('#')) {
        variants.push(new HlsVariant({
          bandwidth,
          resolution,
          codecs,
          url: toAbsoluteUrl(urlLine, baseUrl)
        }));
      }
    }

    // Parse segment duration
    if (line.startsWith('#EXTINF:')) {
      const match = line.match(/#EXTINF:([\d.]+)/);
      currentDuration = match ? parseFloat(match[1]) : 0;
    }

    // Parse media playlist segments
    if (line && !line.startsWith('#')) {
      // It's a segment URL
      if (!lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
        segments.push(new HlsSegment(
          toAbsoluteUrl(line, baseUrl),
          currentDuration,
          runningTime
        ));
        runningTime += currentDuration;
        currentDuration = 0;
      }
    }
  }

  return { variants, segments };
}

/**
 * Parse an HLS playlist from URL
 * If it's a master playlist, returns variants. If media playlist, returns segments.
 * 
 * @param {string} url - HLS playlist URL
 * @param {object} [options] - Options
 * @param {function} [options.onProgress] - Progress callback
 * @returns {Promise<HlsStream>}
 */
async function parseHls(url, options = {}) {
  const log = options.onProgress || (() => {});
  
  log('Fetching playlist...');
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch playlist: ${response.status} ${response.statusText}`);
  }
  
  const text = await response.text();
  const { variants, segments } = parsePlaylistText(text, url);

  if (variants.length > 0) {
    // Master playlist
    log(`Found ${variants.length} quality variants`);
    return new HlsStream(url, variants);
  } else if (segments.length > 0) {
    // Media playlist (no variants)
    log(`Found ${segments.length} segments`);
    return new HlsStream(url, [], segments);
  } else {
    throw new Error('Invalid HLS playlist: no variants or segments found');
  }
}

/**
 * Download segments from an HLS stream
 * 
 * @param {HlsStream|string} source - HlsStream object or URL
 * @param {object} [options] - Options
 * @param {string|number} [options.quality] - 'highest', 'lowest', or bandwidth number
 * @param {number} [options.maxSegments] - Max segments to download (default: all)
 * @param {number} [options.startTime] - Start time in seconds (downloads segments that overlap)
 * @param {number} [options.endTime] - End time in seconds
 * @param {function} [options.onProgress] - Progress callback
 * @returns {Promise<Uint8Array>} Combined segment data
 */
async function downloadHls(source, options = {}) {
  const log = options.onProgress || (() => {});
  
  // Parse if given a URL string
  let stream = source;
  if (typeof source === 'string') {
    stream = await parseHls(source, options);
  }
  
  // Select quality if specified
  if (options.quality) {
    stream.select(options.quality);
  }

  // Get segments
  let segments = stream.segments;
  
  // If master playlist, fetch the selected variant's media playlist
  if (stream.isMaster && stream.selected) {
    const variant = stream.selected;
    log(`Selected: ${variant.name} (${variant.kbps} kbps)`);
    
    const mediaResponse = await fetch(variant.url);
    if (!mediaResponse.ok) {
      throw new Error(`Failed to fetch media playlist: ${mediaResponse.status}`);
    }
    
    const mediaText = await mediaResponse.text();
    const { segments: mediaSegments } = parsePlaylistText(mediaText, variant.url);
    segments = mediaSegments;
  }

  if (!segments || segments.length === 0) {
    throw new Error('No segments found in playlist');
  }

  // Filter by time range if specified
  let toDownload = segments;
  const hasTimeRange = options.startTime !== undefined || options.endTime !== undefined;
  
  if (hasTimeRange) {
    const startTime = options.startTime || 0;
    const endTime = options.endTime !== undefined ? options.endTime : Infinity;
    
    // Find segments that overlap with the time range
    toDownload = segments.filter(seg => seg.endTime > startTime && seg.startTime < endTime);
    
    if (toDownload.length > 0) {
      const actualStart = toDownload[0].startTime;
      const actualEnd = toDownload[toDownload.length - 1].endTime;
      log(`Time range: ${startTime}s-${endTime}s → segments ${actualStart.toFixed(1)}s-${actualEnd.toFixed(1)}s`);
    }
  }

  // Limit segments if specified (applied after time filtering)
  if (options.maxSegments && toDownload.length > options.maxSegments) {
    toDownload = toDownload.slice(0, options.maxSegments);
  }
  
  const totalSegments = toDownload.length;
  log(`Downloading ${totalSegments} segment${totalSegments > 1 ? 's' : ''}...`);

  // Download segments with progress tracking
  let completedSegments = 0;
  const buffers = await Promise.all(
    toDownload.map(async (seg, i) => {
      const url = seg.url || seg; // Handle both HlsSegment objects and plain URLs
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`Segment ${i + 1} failed: ${resp.status}`);
      }
      const buffer = new Uint8Array(await resp.arrayBuffer());
      completedSegments++;
      const percent = Math.round((completedSegments / totalSegments) * 50); // Download is 0-50%
      log(`Downloading: ${percent}%`, { phase: 'download', percent, segment: completedSegments, totalSegments });
      return buffer;
    })
  );

  // Combine into single buffer
  const totalSize = buffers.reduce((sum, buf) => sum + buf.length, 0);
  const combined = new Uint8Array(totalSize);
  let offset = 0;
  for (const buf of buffers) {
    combined.set(buf, offset);
    offset += buf.length;
  }

  log(`Downloaded ${(totalSize / 1024 / 1024).toFixed(2)} MB`, { phase: 'download', percent: 50 });
  
  // Return with metadata for precise clipping
  combined._hlsTimeRange = hasTimeRange ? {
    requestedStart: options.startTime || 0,
    requestedEnd: options.endTime,
    actualStart: toDownload[0]?.startTime || 0,
    actualEnd: toDownload[toDownload.length - 1]?.endTime || 0
  } : null;
  
  return combined;
}

/**
 * Check if a URL looks like an HLS playlist
 * @param {string} url - URL to check
 * @returns {boolean}
 */
function isHlsUrl(url) {
  if (typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  return lower.includes('.m3u8') || lower.includes('format=m3u8');
}

export { 
  HlsStream, 
  HlsVariant, 
  HlsSegment,
  parseHls, 
  downloadHls, 
  isHlsUrl,
  parsePlaylistText,
  toAbsoluteUrl
};

