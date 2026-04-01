/**
 * Standard MP4 Clipper
 *
 * Clips a standard (non-fragmented) MP4 to a time range, producing a new MP4
 * with frame-accurate edit lists. Reuses the fMP4 converter's rebuild pipeline.
 *
 * @module mp4-clip
 */

import { MP4Parser } from './parsers/mp4.js';
import {
    parseBoxes,
    findBox,
    parseChildBoxes,
    createBox,
    getMovieTimescale,
} from './fmp4/utils.js';
import {
    applyClipToTracks,
    rebuildMdatContent,
    calculateMovieDuration,
    rebuildTrak,
    rebuildMvhd,
    updateStcoOffsets,
} from './fmp4/converter.js';

/**
 * Convert MP4Parser samples to the format expected by the clipping pipeline.
 * MP4Parser returns times in seconds; the clipper needs ticks.
 */
function convertSamples(parserSamples, timescale) {
    return parserSamples.map(s => ({
        duration: Math.round(s.duration * timescale),
        size: s.size,
        flags: s.isKeyframe ? 0 : 0x10000,
        compositionTimeOffset: Math.round((s.pts - s.dts) * timescale),
        dts: Math.round(s.dts * timescale),
        pts: Math.round(s.pts * timescale),
        byteOffset: s.offset,
    }));
}

/**
 * Clip a standard MP4 to a time range.
 *
 * @param {Uint8Array} mp4Data - Standard MP4 data
 * @param {object} [options]
 * @param {number} [options.startTime] - Start time in seconds
 * @param {number} [options.endTime] - End time in seconds
 * @returns {Uint8Array} Clipped MP4 data
 */
export function clipMp4(mp4Data, options = {}) {
    const parser = new MP4Parser(mp4Data);
    const videoTrack = parser.videoTrack;
    const audioTrack = parser.audioTrack;

    if (!videoTrack) throw new Error('No video track found in MP4');

    // Build tracks map in the format expected by applyClipToTracks
    const tracks = new Map();
    const trackOrder = [];

    const vSamples = convertSamples(parser.getVideoSamples(), videoTrack.timescale);
    tracks.set(videoTrack.trackId, {
        trackId: videoTrack.trackId,
        timescale: videoTrack.timescale,
        handlerType: 'vide',
        samples: vSamples,
        chunkOffsets: [],
        mediaTime: 0,
        playbackDuration: 0,
    });
    trackOrder.push(videoTrack.trackId);

    if (audioTrack) {
        const aSamples = convertSamples(parser.getAudioSamples(), audioTrack.timescale);
        tracks.set(audioTrack.trackId, {
            trackId: audioTrack.trackId,
            timescale: audioTrack.timescale,
            handlerType: 'soun',
            samples: aSamples,
            chunkOffsets: [],
            mediaTime: 0,
            playbackDuration: 0,
        });
        trackOrder.push(audioTrack.trackId);
    }

    // Clip samples (reuses fMP4 converter's logic, including A/V sync fix)
    const clippedTracks = applyClipToTracks(tracks, options);
    if (clippedTracks.size === 0) throw new Error('Clip range produced no samples');

    // Parse top-level boxes for rebuild
    const boxes = parseBoxes(mp4Data);
    const ftyp = findBox(boxes, 'ftyp');
    const moov = findBox(boxes, 'moov');
    if (!ftyp || !moov) throw new Error('Invalid MP4: missing ftyp or moov');

    const movieTimescale = getMovieTimescale(moov);

    // Rebuild mdat — sample byteOffsets are absolute file offsets, so pass the
    // entire file as the source buffer
    const rebuiltMdat = rebuildMdatContent(clippedTracks, trackOrder, mp4Data);
    const maxMovieDuration = calculateMovieDuration(clippedTracks, movieTimescale);

    // Rebuild moov with clipped timing
    const moovChildren = parseChildBoxes(moov);
    const newMoovParts = [];
    for (const child of moovChildren) {
        if (child.type === 'mvex') continue;
        if (child.type === 'trak') {
            const trak = rebuildTrak(child, clippedTracks, maxMovieDuration);
            if (trak) newMoovParts.push(trak);
        } else if (child.type === 'mvhd') {
            newMoovParts.push(rebuildMvhd(child, maxMovieDuration));
        } else {
            newMoovParts.push(child.data);
        }
    }

    // Assemble final MP4: ftyp + moov + mdat
    const newMoov = createBox('moov', ...newMoovParts);
    const newMdat = createBox('mdat', rebuiltMdat);
    const output = new Uint8Array(ftyp.size + newMoov.byteLength + newMdat.byteLength);
    output.set(ftyp.data, 0);
    output.set(newMoov, ftyp.size);
    output.set(newMdat, ftyp.size + newMoov.byteLength);
    updateStcoOffsets(output, ftyp.size, newMoov.byteLength);
    return output;
}

export default clipMp4;
