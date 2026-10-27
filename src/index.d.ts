declare module '@invintusmedia/tomp4' {
  export interface Mp4Result {
    /** Raw MP4 data */
    data: Uint8Array;
    /** Suggested filename */
    filename: string;
    /** Size in bytes */
    size: number;
    /** Human-readable size (e.g. "2.5 MB") */
    sizeFormatted: string;
    /** Get as Blob */
    toBlob(): Blob;
    /** Get as object URL for video.src */
    toURL(): string;
    /** Revoke the object URL to free memory */
    revokeURL(): void;
    /** Trigger browser download */
    download(filename?: string): void;
    /** Get as ArrayBuffer */
    toArrayBuffer(): ArrayBuffer;
  }

  export interface HlsVariant {
    url: string;
    bandwidth: number;
    resolution?: string;
    width?: number;
    height?: number;
    codecs?: string;
    /** GROUP-ID of the demuxed audio rendition this variant references, if any */
    audioGroup?: string | null;
  }

  export interface HlsAudioRendition {
    groupId: string | null;
    name: string | null;
    language: string | null;
    isDefault: boolean;
    autoselect: boolean;
    /** Absolute URL of the audio media playlist */
    url: string;
  }

  export interface HlsStream {
    masterUrl: string;
    variants: HlsVariant[];
    /** Demuxed audio renditions (#EXT-X-MEDIA:TYPE=AUDIO with a URI) */
    audioRenditions: HlsAudioRendition[];
    qualities: string[];
    select(quality: string | number): HlsStream;
    segments: string[];
  }

  export interface ProgressInfo {
    /** Current phase: 'download' or 'convert' */
    phase: 'download' | 'convert';
    /** Progress percentage (0-100) */
    percent: number;
    /** Current segment (download phase only) */
    segment?: number;
    /** Total segments (download phase only) */
    totalSegments?: number;
  }

  export interface ToMp4Options {
    /** Progress callback - receives message string and optional progress info */
    onProgress?: (message: string, info?: ProgressInfo) => void;
    /** Suggested filename for downloads */
    filename?: string;
    /** HLS quality: 'highest', 'lowest', or bandwidth number */
    quality?: 'highest' | 'lowest' | number;
    /** Max HLS segments to download */
    maxSegments?: number;
    /** Start time in seconds (snaps to nearest keyframe) */
    startTime?: number;
    /** End time in seconds */
    endTime?: number;
  }

  export interface ThumbnailOptions {
    /** Time in seconds to capture (default ~0.15) */
    time?: number;
    /** Resize output to this width (preserve aspect) */
    maxWidth?: number;
    /** Output mime type */
    mimeType?: 'image/jpeg' | 'image/webp' | 'image/png';
    /** 0..1 (jpeg/webp only) */
    quality?: number;
    /** Overall timeout (ms) */
    timeoutMs?: number;
    /** HLS quality to download for thumbnail generation */
    hlsQuality?: 'lowest' | 'highest';
  }

  export interface ThumbnailsOptions {
    /** Times in seconds to capture */
    times: number[];
    /** Resize output to this width (default 80) */
    maxWidth?: number;
    /** Output mime type */
    mimeType?: 'image/jpeg' | 'image/webp' | 'image/png';
    /** 0..1 (jpeg/webp only, default 0.6) */
    quality?: number;
    /** Overall timeout in ms (default 30000) */
    timeoutMs?: number;
    /** HLS quality variant to use (default 'lowest') */
    hlsQuality?: 'lowest' | 'highest';
    /** Max segments fetched in parallel (default 4) */
    concurrency?: number;
    /** Called as each thumbnail completes */
    onThumbnail?: (time: number, image: ImageResult) => void;
    /**
     * If true, always fetch full media segments and extract the exact frame
     * at each requested time. Use this when the thumbnail must match what
     * the player shows at time `t` (e.g. scene descriptions, title cards).
     * Default (`false`) prefers the I-frame playlist when available — faster
     * but snaps to the nearest keyframe, which can be several seconds off.
     */
    accurate?: boolean;
  }

  export class ImageResult {
    blob: Blob;
    filename: string;
    constructor(blob: Blob, filename?: string);
    toBlob(): Blob;
    toURL(): string;
    revokeURL(): void;
    download(filename?: string): void;
  }

  export interface StitchFmp4Options {
    /** Separate init segment (ftyp/moov) if not included in data segments */
    init?: Uint8Array | ArrayBuffer;
  }

  export interface KeyframeInfo {
    /** Frame index */
    index: number;
    /** Time in seconds */
    time: number;
  }

  export interface AnalysisResult {
    /** Total duration in seconds */
    duration: number;
    /** Number of video frames */
    videoFrames: number;
    /** Number of audio frames */
    audioFrames: number;
    /** Keyframe positions */
    keyframes: KeyframeInfo[];
    /** Number of keyframes */
    keyframeCount: number;
    /** Video codec name */
    videoCodec: string;
    /** Audio codec name */
    audioCodec: string;
    /** Audio sample rate */
    audioSampleRate: number | null;
    /** Audio channel count */
    audioChannels: number | null;
  }

  export interface MP4Sample {
    /** Sample index */
    index: number;
    /** Byte offset in file */
    offset: number;
    /** Sample size in bytes */
    size: number;
    /** Decode timestamp in seconds */
    dts: number;
    /** Presentation timestamp in seconds */
    pts: number;
    /** Alias for pts */
    time: number;
    /** Sample duration in seconds */
    duration: number;
    /** Whether this is a keyframe */
    isKeyframe: boolean;
    /** Sample data (only present after getSampleData) */
    data?: Uint8Array;
  }

  export interface MP4ParserInfo {
    /** Duration in seconds */
    duration: number;
    /** Video width */
    width: number;
    /** Video height */
    height: number;
    /** Whether source has audio */
    hasAudio: boolean;
    /** Whether video has B-frames */
    hasBframes: boolean;
    /** Number of video samples */
    videoSampleCount: number;
    /** Number of audio samples */
    audioSampleCount: number;
    /** Number of keyframes */
    keyframeCount: number;
  }

  /**
   * MP4 Parser - Parse local MP4 files
   * 
   * @example
   * const parser = new MP4Parser(uint8ArrayData);
   * console.log(parser.duration, parser.width, parser.height);
   * 
   * // Get samples
   * const videoSamples = parser.getVideoSamples();
   * const audioSamples = parser.getAudioSamples();
   * 
   * // Build HLS segments
   * const segments = parser.buildSegments(4);
   * 
   * // Get sample data
   * const samplesWithData = parser.getSampleData(videoSamples.slice(0, 10));
   */
  export class MP4Parser {
    /** Duration in seconds */
    readonly duration: number;
    /** Video width */
    readonly width: number;
    /** Video height */
    readonly height: number;
    /** Whether source has audio */
    readonly hasAudio: boolean;
    /** Whether video has B-frames */
    readonly hasBframes: boolean;
    /** Video codec config (SPS/PPS) */
    readonly videoCodecConfig: { sps: Uint8Array[]; pps: Uint8Array[]; profile: number; level: number; nalLengthSize: number } | null;
    /** Audio codec config */
    readonly audioCodecConfig: { sampleRate: number; channels: number } | null;

    /**
     * Create parser from MP4 data
     * @param data - Complete MP4 file data
     */
    constructor(data: Uint8Array);

    /** Get video sample table */
    getVideoSamples(): MP4Sample[];

    /** Get audio sample table */
    getAudioSamples(): MP4Sample[];

    /**
     * Build HLS-style segments
     * @param targetDuration - Target segment duration in seconds (default 4)
     * @param options.boundary - 'before' (default): segments stay under the
     *   target; 'after': each ends at the first keyframe at or after it
     *   (ffmpeg's hls_time)
     */
    buildSegments(targetDuration?: number, options?: { boundary?: 'before' | 'after' }): RemoteMp4Segment[];

    /**
     * Get sample data for a range of samples
     * Reads data from the original buffer
     * @param samples - Samples to extract
     */
    getSampleData(samples: MP4Sample[]): MP4Sample[];

    /** Get parser info */
    getInfo(): MP4ParserInfo;
  }

  export interface RemoteMp4Info {
    /** Source URL */
    url: string;
    /** File size in bytes */
    fileSize: number;
    /** Duration in seconds */
    duration: number;
    /** Video width */
    width: number;
    /** Video height */
    height: number;
    /** Whether source has audio */
    hasAudio: boolean;
    /** Whether video has B-frames */
    hasBframes: boolean;
    /** Number of HLS segments */
    segmentCount: number;
    /** Number of video samples */
    videoSampleCount: number;
    /** Number of audio samples */
    audioSampleCount: number;
    /** Number of keyframes */
    keyframeCount: number;
    /** Frames per second */
    frameRate: number;
    /** RFC 6381 codecs, e.g. `avc1.4d4028,mp4a.40.2` */
    codecs: string;
    /** Peak bitrate estimate (bits/s, MPEG-TS) */
    bandwidth: number;
    /** Average bitrate estimate (bits/s, MPEG-TS) */
    averageBandwidth: number;
    /** Edit lists applied (seconds); null when the track is absent */
    edits: { video: RemoteMp4Edit; audio: RemoteMp4Edit | null } | null;
    /** Origin ETag pinned at init */
    etag: string | null;
  }

  export interface RemoteMp4Edit {
    /** Leading empty edits (track starts this much later) */
    emptyDuration: number;
    /** Media time presented first (trimmed from the start) */
    mediaTime: number;
    entryCount: number;
  }

  export interface RemoteMp4Segment {
    /** Segment index */
    index: number;
    /** Start time in seconds */
    startTime: number;
    /** End time in seconds */
    endTime: number;
    /** Duration in seconds */
    duration: number;
  }

  export interface RemoteMp4Options {
    /** Target segment duration in seconds, keyframe-aligned (default 4) */
    segmentDuration?: number;
    /**
     * 'before' (default): segments stay under `segmentDuration`; 'after':
     * each ends at the first keyframe at or after it (ffmpeg's hls_time)
     */
    segmentBoundary?: 'before' | 'after';
    /** Per-request origin timeout in ms, whole body (default 30000) */
    timeoutMs?: number;
    /** Retries for network errors / 5xx (default 2) */
    retries?: number;
    /** Extra origin request headers */
    headers?: Record<string, string>;
    /** fetch implementation (default globalThis.fetch) */
    fetch?: typeof fetch;
    /** Progress callback */
    onProgress?: (message: string) => void;
  }

  export interface RemoteMp4PlaylistOptions {
    /** Segment URI for a 0-based index (default `segment{index}.ts`) */
    segmentName?: (index: number) => string;
    /** Slice start, seconds */
    start?: number;
    /** Slice end, seconds */
    end?: number;
  }

  /**
   * Error with an HTTP-style status; `code` mirrors Fastly OTFP's
   * X-Fastly-Package-Error ("Origin 404", "Origin timeout", ...).
   */
  export class RemoteMp4Error extends Error {
    constructor(code: string, options?: { status?: number; detail?: string; cause?: unknown; retryable?: boolean });
    readonly code: string;
    readonly status: number;
    readonly retryable: boolean;
  }

  /** A sample from RemoteMp4's tables (presentation-time seconds; edit lists applied) */
  export interface RemoteMp4Sample {
    /** Position in the table (matches segment videoStart/videoEnd) */
    index: number;
    /** Byte offset in the file */
    offset: number;
    size: number;
    duration: number;
    pts: number;
    dts: number;
    /** Presentation time (same as pts) */
    time: number;
    isKeyframe: boolean;
  }

  /**
   * Remote MP4 parser for on-demand HLS serving
   * 
   * @example
   * const source = await RemoteMp4.fromUrl('https://example.com/video.mp4');
   * console.log(source.duration, source.segments.length);
   * 
   * // Get HLS playlists
   * const masterPlaylist = source.getMasterPlaylist();
   * const mediaPlaylist = source.getMediaPlaylist();
   * 
   * // Get segment as MPEG-TS
   * const tsData = await source.getSegment(0);
   */
  export class RemoteMp4 {
    /** Source URL */
    readonly url: string;
    /** File size in bytes */
    readonly fileSize: number;
    /** Duration in seconds */
    readonly duration: number;
    /** Video width */
    readonly width: number;
    /** Video height */
    readonly height: number;
    /** Whether source has audio */
    readonly hasAudio: boolean;
    /** Whether video has B-frames */
    readonly hasBframes: boolean;
    /** HLS segments */
    readonly segments: RemoteMp4Segment[];
    /** Frames per second */
    readonly frameRate: number;
    /** RFC 6381 codecs */
    readonly codecs: string;
    /** Peak bitrate estimate (bits/s) */
    readonly bandwidth: number;
    /** Average bitrate estimate (bits/s) */
    readonly averageBandwidth: number;
    /** Origin ETag pinned at init (null when absent or not exposed cross-origin) */
    readonly etag: string | null;
    /** Origin Last-Modified at init */
    readonly lastModified: string | null;
    /** The file's moov box */
    readonly moov: Uint8Array | null;
    /** Parsed video track (sample tables in media time) */
    readonly videoTrack: object | null;
    /** Parsed audio track (sample tables in media time) */
    readonly audioTrack: object | null;
    /** Video samples in decode order, built on first access */
    readonly videoSamples: RemoteMp4Sample[];
    /** Audio samples, built on first access */
    readonly audioSamples: RemoteMp4Sample[];

    /**
     * Create RemoteMp4 from URL
     * Only fetches metadata (moov) - segments are loaded on-demand
     */
    static fromUrl(url: string, options?: RemoteMp4Options): Promise<RemoteMp4>;

    /** Get source information */
    getInfo(): RemoteMp4Info;

    /** Get segment definitions */
    getSegments(): RemoteMp4Segment[];

    /** Segments overlapping [start, end) seconds; all when unset */
    segmentsInRange(start?: number, end?: number): RemoteMp4Segment[];

    /**
     * Generate HLS master playlist
     * @param baseUrl - Base URL for playlist references (default '')
     */
    getMasterPlaylist(baseUrl?: string, variantUri?: string): string;

    /** Master playlist for several renditions, in the order given */
    static buildMasterPlaylist(variants: Array<{ source: RemoteMp4; uri: string }>): string;

    /** `#EXT-X-STREAM-INF` attributes (BANDWIDTH, CODECS, RESOLUTION, ...) */
    getStreamInfAttributes(): string;

    /**
     * Generate HLS media playlist
     * @param baseUrl - Base URL for segment references (default '')
     */
    getMediaPlaylist(baseUrl?: string, options?: RemoteMp4PlaylistOptions): string;

    /**
     * Get a segment as MPEG-TS data
     * Fetches only the required byte ranges from the source
     * @param index - Segment index
     */
    getSegment(index: number): Promise<Uint8Array>;
  }

  /**
   * Convert video to MP4
   * @param input - URL, HLS stream, or video data
   * @param options - Conversion options
   */
  function toMp4(
    input: string | Uint8Array | ArrayBuffer | Blob | HlsStream,
    options?: ToMp4Options
  ): Promise<Mp4Result>;

  namespace toMp4 {
    /** Library version */
    const version: string;

    /** Convert MPEG-TS data to MP4 */
    function fromTs(data: Uint8Array | ArrayBuffer, options?: ToMp4Options): Mp4Result;

    /** Convert fMP4 data to MP4 */
    function fromFmp4(data: Uint8Array | ArrayBuffer, options?: ToMp4Options): Mp4Result;

    /** Detect format of video data */
    function detectFormat(data: Uint8Array): 'mpegts' | 'fmp4' | 'mp4' | 'unknown';

    /** Check if data is MPEG-TS */
    function isMpegTs(data: Uint8Array): boolean;

    /** Check if data is fMP4 */
    function isFmp4(data: Uint8Array): boolean;

    /** Check if data is standard MP4 */
    function isStandardMp4(data: Uint8Array): boolean;

    /** Parse HLS playlist */
    function parseHls(url: string): Promise<HlsStream>;

    /** Download and combine HLS segments */
    function downloadHls(
      input: string | HlsStream,
      options?: ToMp4Options
    ): Promise<Uint8Array>;

    /** Check if URL is an HLS playlist */
    function isHlsUrl(url: string): boolean;

    /** Analyze MPEG-TS data without converting */
    function analyze(data: Uint8Array): AnalysisResult;

    /** MP4 Parser for local files */
    const MP4Parser: typeof import('@invintusmedia/tomp4').MP4Parser;

    /** Remote MP4 parser for on-demand HLS serving */
    const RemoteMp4: typeof import('@invintusmedia/tomp4').RemoteMp4;

    /** Error thrown by RemoteMp4 (HTTP-style status, OTFP-style code) */
    const RemoteMp4Error: typeof import('@invintusmedia/tomp4').RemoteMp4Error;

    /** 
     * Stitch multiple fMP4 segments into a single MP4
     * For live streams saved as 4-second fMP4 chunks
     */
    function stitchFmp4(
      segments: (Uint8Array | ArrayBuffer)[],
      options?: StitchFmp4Options
    ): Mp4Result;

    /**
     * Extract a single frame as an image (browser-only).
     * For HLS inputs, downloads a minimal range and remuxes to MP4 before capture.
     */
    function thumbnail(
      input:
        | string
        | Uint8Array
        | ArrayBuffer
        | Blob
        | HlsStream
        | { init?: Uint8Array | ArrayBuffer; segments: (Uint8Array | ArrayBuffer)[] },
      options?: ThumbnailOptions
    ): Promise<ImageResult>;

    /**
     * Batch thumbnail extraction from an HLS stream (browser-only).
     * Parses the playlist once, groups times by segment, fetches each segment
     * once, and reuses a single video element per segment.
     */
    function thumbnails(
      input: string | HlsStream,
      options: ThumbnailsOptions
    ): Promise<Map<number, ImageResult>>;
  }

  export default toMp4;
  export { toMp4 };
  export const stitchFmp4: typeof toMp4.stitchFmp4;
  export const thumbnail: typeof toMp4.thumbnail;
  export const thumbnails: typeof toMp4.thumbnails;
}
