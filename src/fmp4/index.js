/**
 * fMP4 Module
 * 
 * Handles fragmented MP4 (fMP4) processing:
 * - Converting single fMP4 files to standard MP4
 * - Stitching multiple fMP4 segments into a single MP4
 * 
 * @module fmp4
 */

export { convertFmp4ToMp4 } from './converter.js';
export { stitchFmp4 } from './stitcher.js';

// Re-export utilities for advanced use cases
export {
    parseBoxes,
    findBox,
    parseChildBoxes,
    createBox,
    parseTfhd,
    parseTfdt,
    parseTrun,
    extractTrackIds,
    getMovieTimescale
} from './utils.js';
