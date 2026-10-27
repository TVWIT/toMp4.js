/**
 * fMP4 to Standard MP4 Converter
 *
 * Converts fragmented MP4 data to standard MP4 and supports
 * sample-level clipping for fMP4 inputs.
 *
 * @module fmp4/converter
 */

import {
    parseBoxes,
    findBox,
    parseChildBoxes,
    createBox,
    parseTfhd,
    parseTfdt,
    parseTrun,
    getMovieTimescale,
} from './utils.js';
import { parseElst, summarizeEdits } from '../parsers/mp4.js';

function createFullBox(type, version, flags, ...payloads) {
    const header = new Uint8Array(4);
    header[0] = version;
    header[1] = (flags >> 16) & 0xff;
    header[2] = (flags >> 8) & 0xff;
    header[3] = flags & 0xff;
    return createBox(type, header, ...payloads);
}

function sumSampleDurations(samples) {
    let total = 0;
    for (const sample of samples) total += sample.duration || 0;
    return total;
}

function toMovieTimescale(value, trackTimescale, movieTimescale) {
    if (!trackTimescale || !movieTimescale) return value;
    return Math.round((value * movieTimescale) / trackTimescale);
}

function isSyncSample(sample) {
    const flags = sample.flags;
    if (flags === undefined || flags === null) return true;
    return ((flags >> 16) & 0x1) === 0;
}

function parseTrex(trexData) {
    const view = new DataView(trexData.buffer, trexData.byteOffset, trexData.byteLength);
    return {
        trackId: view.getUint32(12),
        defaultSampleDuration: view.getUint32(20),
        defaultSampleSize: view.getUint32(24),
        defaultSampleFlags: view.getUint32(28),
    };
}

function extractTrexDefaults(moovBox) {
    const defaults = new Map();
    const moovChildren = parseChildBoxes(moovBox);
    const mvex = findBox(moovChildren, 'mvex');
    if (!mvex) return defaults;

    const mvexChildren = parseChildBoxes(mvex);
    for (const child of mvexChildren) {
        if (child.type !== 'trex') continue;
        const trex = parseTrex(child.data);
        defaults.set(trex.trackId, trex);
    }
    return defaults;
}

function extractTrackMetadata(moovBox) {
    const trackMetadata = new Map();
    const trackOrder = [];
    const moovChildren = parseChildBoxes(moovBox);
    const movieTimescale = getMovieTimescale(moovBox);

    for (const child of moovChildren) {
        if (child.type !== 'trak') continue;
        const trakChildren = parseChildBoxes(child);

        let trackId = null;
        let timescale = 0;
        let handlerType = 'unknown';
        let elstEntries = null;

        for (const trakChild of trakChildren) {
            if (trakChild.type === 'edts') {
                const elst = findBox(parseChildBoxes(trakChild), 'elst');
                if (elst) elstEntries = parseElst(elst.data, 0);
            } else if (trakChild.type === 'tkhd') {
                const view = new DataView(trakChild.data.buffer, trakChild.data.byteOffset, trakChild.data.byteLength);
                trackId = trakChild.data[8] === 0 ? view.getUint32(20) : view.getUint32(28);
            } else if (trakChild.type === 'mdia') {
                const mdiaChildren = parseChildBoxes(trakChild);
                for (const mdiaChild of mdiaChildren) {
                    if (mdiaChild.type === 'mdhd') {
                        const view = new DataView(mdiaChild.data.buffer, mdiaChild.data.byteOffset, mdiaChild.data.byteLength);
                        timescale = mdiaChild.data[8] === 0 ? view.getUint32(20) : view.getUint32(28);
                    } else if (mdiaChild.type === 'hdlr' && mdiaChild.data.byteLength >= 20) {
                        handlerType = String.fromCharCode(
                            mdiaChild.data[16],
                            mdiaChild.data[17],
                            mdiaChild.data[18],
                            mdiaChild.data[19],
                        );
                    }
                }
            }
        }

        if (trackId !== null) {
            // Media time presented at 0 (B-frame delay, AAC priming), in ticks.
            // Clipping applies it so clip times are presentation times.
            let editShift = 0;
            if (elstEntries && timescale) {
                const edit = summarizeEdits(elstEntries, timescale, movieTimescale);
                editShift = Math.round((edit.mediaTime - edit.emptyDuration) * timescale);
            }
            trackMetadata.set(trackId, {
                trackId,
                timescale: timescale || 90000,
                handlerType,
                editShift,
            });
            trackOrder.push(trackId);
        }
    }

    return { trackMetadata, trackOrder };
}

function cloneSample(sample) {
    return {
        duration: sample.duration || 0,
        size: sample.size || 0,
        flags: sample.flags,
        compositionTimeOffset: sample.compositionTimeOffset || 0,
        dts: sample.dts || 0,
        pts: sample.pts || 0,
        byteOffset: sample.byteOffset || 0,
    };
}

function normalizeSamples(samples, baseDts) {
    return samples.map((sample) => {
        const next = cloneSample(sample);
        next.dts -= baseDts;
        next.pts -= baseDts;
        return next;
    });
}

function clipVideoSamples(samples, startTick, endTick) {
    if (!samples.length) {
        return { samples: [], mediaTime: 0, playbackDuration: 0 };
    }

    let requestedStartIndex = samples.length;
    for (let i = 0; i < samples.length; i++) {
        const sampleEnd = (samples[i].pts || 0) + (samples[i].duration || 0);
        if (sampleEnd > startTick) {
            requestedStartIndex = i;
            break;
        }
    }
    if (requestedStartIndex >= samples.length) {
        return { samples: [], mediaTime: 0, playbackDuration: 0 };
    }

    let decodeStartIndex = requestedStartIndex;
    for (let i = requestedStartIndex; i >= 0; i--) {
        if (isSyncSample(samples[i])) {
            decodeStartIndex = i;
            break;
        }
    }

    let endIndex = samples.length;
    if (Number.isFinite(endTick)) {
        for (let i = decodeStartIndex; i < samples.length; i++) {
            if ((samples[i].pts || 0) >= endTick) {
                endIndex = i;
                break;
            }
        }
    }
    if (endIndex <= decodeStartIndex) {
        return { samples: [], mediaTime: 0, playbackDuration: 0 };
    }

    // Snap the start to the beginning of the frame that contains it (the
    // frame shown first). A start inside a frame is ambiguous — players
    // round it differently — and audio must be cut at the same instant.
    let snappedStart = -Infinity;
    for (let i = decodeStartIndex; i < endIndex; i++) {
        const pts = samples[i].pts || 0;
        if (pts <= startTick && pts > snappedStart) snappedStart = pts;
    }
    if (!Number.isFinite(snappedStart)) snappedStart = startTick;
    startTick = snappedStart;

    const selected = samples.slice(decodeStartIndex, endIndex);
    const decodeStartDts = selected[0].dts || 0;
    const mediaTime = Math.max(0, startTick - decodeStartDts);
    const normalized = normalizeSamples(selected, decodeStartDts);
    // Presentation ends after the last frame shown, which with B-frames is
    // later than the last decode time
    let presentationEnd = 0;
    for (const sample of normalized) {
        presentationEnd = Math.max(presentationEnd, (sample.pts || 0) + (sample.duration || 0));
    }
    const maxPlayable = Math.max(0, presentationEnd - mediaTime);
    const requested = Number.isFinite(endTick) ? Math.max(0, endTick - startTick) : maxPlayable;
    const playbackDuration = Math.min(requested, maxPlayable);

    return {
        samples: normalized,
        mediaTime,
        playbackDuration,
        startTick,
    };
}

function clipNonVideoSamples(samples, startTick, endTick) {
    if (!samples.length) {
        return { samples: [], mediaTime: 0, playbackDuration: 0 };
    }

    // Start with the sample that contains startTick, so the track never
    // starts after the requested instant (the edit list trims the rest).
    let startIndex = 0;
    while (startIndex < samples.length && (samples[startIndex].pts || 0) + (samples[startIndex].duration || 0) <= startTick) {
        startIndex++;
    }
    if (startIndex >= samples.length) {
        return { samples: [], mediaTime: 0, playbackDuration: 0 };
    }

    let endIndex = samples.length;
    if (Number.isFinite(endTick)) {
        for (let i = startIndex; i < samples.length; i++) {
            if ((samples[i].pts || 0) >= endTick) {
                endIndex = i;
                break;
            }
        }
    }
    if (endIndex <= startIndex) {
        return { samples: [], mediaTime: 0, playbackDuration: 0 };
    }

    const selected = samples.slice(startIndex, endIndex);
    const decodeStartDts = selected[0].dts || 0;
    const normalized = normalizeSamples(selected, decodeStartDts);
    const decodeDuration = sumSampleDurations(normalized);
    const requested = Number.isFinite(endTick) ? Math.max(0, endTick - startTick) : decodeDuration;
    const playbackDuration = Math.min(requested, decodeDuration);

    return {
        samples: normalized,
        mediaTime: 0,
        playbackDuration,
        startPts: selected[0].pts || 0,
    };
}

/**
 * Shift samples onto the timeline the clip times refer to. Applies each
 * track's source edit list (`editShift`) so both tracks are cut at the same
 * presented instant, and with `_clipFromFirstFrame` (HLS downloads, which
 * clip relative to the first downloaded segment) rebases so the first video
 * frame is presented at 0 — fMP4 keeps absolute decode times.
 */
function toPresentationTimeline(tracks, options) {
    const anyShift = [...tracks.values()].some((t) => t.editShift);
    if (!anyShift && !options._clipFromFirstFrame) return tracks;

    let baseSec = 0;
    if (options._clipFromFirstFrame) {
        let first = Infinity;
        for (const [, t] of tracks) {
            if (t.handlerType !== 'vide' || !t.samples.length) continue;
            for (const s of t.samples) first = Math.min(first, ((s.pts || 0) - (t.editShift || 0)) / t.timescale);
            break;
        }
        if (Number.isFinite(first)) baseSec = first;
    }

    const shifted = new Map();
    for (const [id, t] of tracks) {
        const shift = (t.editShift || 0) + Math.round(baseSec * t.timescale);
        if (!shift) { shifted.set(id, t); continue; }
        shifted.set(id, {
            ...t,
            samples: t.samples.map((s) => ({ ...s, dts: (s.dts || 0) - shift, pts: (s.pts || 0) - shift })),
        });
    }
    return shifted;
}

function applyClipToTracks(tracks, options = {}) {
    const hasStart = Number.isFinite(options.startTime);
    const hasEnd = Number.isFinite(options.endTime);
    if (!hasStart && !hasEnd) {
        for (const [, track] of tracks) {
            if (!track.samples.length) continue;
            const baseDts = track.samples[0].dts || 0;
            track.samples = normalizeSamples(track.samples, baseDts);
            track.mediaTime = 0;
            track.playbackDuration = sumSampleDurations(track.samples);
        }
        return tracks;
    }

    tracks = toPresentationTimeline(tracks, options);

    let startSec = hasStart ? Math.max(0, options.startTime) : 0;
    const endSec = hasEnd ? Math.max(startSec, options.endTime) : Infinity;

    let videoTrackId = null;
    for (const [trackId, track] of tracks) {
        if (track.handlerType === 'vide' && track.samples.length > 0) {
            videoTrackId = trackId;
            break;
        }
    }

    // First pass: clip video to determine preroll duration
    const clipped = new Map();
    let videoPrerollSec = 0;

    if (videoTrackId !== null) {
        const vTrack = tracks.get(videoTrackId);
        if (vTrack && vTrack.samples.length) {
            const startTick = Math.round(startSec * vTrack.timescale);
            const endTick = Number.isFinite(endSec) ? Math.round(endSec * vTrack.timescale) : Infinity;
            const clip = clipVideoSamples(vTrack.samples, startTick, endTick);

            if (clip.samples.length) {
                videoPrerollSec = clip.mediaTime / vTrack.timescale;
                startSec = clip.startTick / vTrack.timescale; // frame-snapped; audio follows
                clipped.set(videoTrackId, {
                    ...vTrack,
                    samples: clip.samples,
                    mediaTime: clip.mediaTime,
                    playbackDuration: clip.playbackDuration,
                    chunkOffsets: [],
                });
            }
        }
    }

    // Second pass: clip non-video tracks, including audio from the video's
    // decode start (keyframe) so A/V stays in sync without edit lists
    for (const [trackId, track] of tracks) {
        if (!track.samples.length || trackId === videoTrackId) continue;

        // Not clamped at 0: on a presentation timeline (source edit lists
        // applied) audio priming sits before 0, and the clamp cut audio
        // ~one preroll later than video for clips near the start.
        const adjustedStartSec = startSec - videoPrerollSec;
        const startTick = Math.round(adjustedStartSec * track.timescale);
        const endTick = Number.isFinite(endSec) ? Math.round(endSec * track.timescale) : Infinity;
        const clip = clipNonVideoSamples(track.samples, startTick, endTick);

        if (!clip.samples.length) continue;

        // Preroll from the audio's own first sample to the requested start.
        // Audio is cut on frame boundaries (e.g. 21 ms for AAC at 48 kHz), so
        // reusing the video's preroll left up to one frame of A/V error. It
        // stays within a frame of the video's preroll, so players that ignore
        // edit lists keep the tracks together too.
        // A track that starts after the requested start (delayed in the
        // source) gets an empty edit for the gap.
        const audioPreroll = Math.round(startSec * track.timescale) - clip.startPts;
        const totalDur = sumSampleDurations(clip.samples);
        const playbackDuration = Math.max(0, totalDur - Math.max(0, audioPreroll));
        const emptyDuration = Number.isFinite(endSec)
            ? Math.min(Math.max(0, -audioPreroll), Math.round((endSec - startSec) * track.timescale))
            : Math.max(0, -audioPreroll);

        clipped.set(trackId, {
            ...track,
            samples: clip.samples,
            mediaTime: Math.max(0, audioPreroll),
            emptyDuration,
            playbackDuration,
            chunkOffsets: [],
        });
    }

    return clipped;
}

function collectTrackSamples(boxes, trackMetadata, trexDefaults) {
    const tracks = new Map();
    const mdatChunks = [];
    let combinedMdatOffset = 0;

    for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        if (box.type === 'moof') {
            const moofChildren = parseChildBoxes(box);
            const moofStart = box.offset;

            let nextMdatOffset = -1;
            for (let j = i + 1; j < boxes.length; j++) {
                if (boxes[j].type === 'mdat') {
                    nextMdatOffset = boxes[j].offset;
                    break;
                }
                if (boxes[j].type === 'moof') break;
            }
            if (nextMdatOffset < 0) continue;

            const mdatContentStartAbs = nextMdatOffset + 8;

            for (const child of moofChildren) {
                if (child.type !== 'traf') continue;

                const trafChildren = parseChildBoxes(child);
                const tfhdBox = findBox(trafChildren, 'tfhd');
                if (!tfhdBox) continue;

                const tfhdView = new DataView(tfhdBox.data.buffer, tfhdBox.data.byteOffset, tfhdBox.data.byteLength);
                const trackId = tfhdView.getUint32(12);
                const tfhd = parseTfhd(tfhdBox.data, trexDefaults.get(trackId) || {});
                const tfdtBox = findBox(trafChildren, 'tfdt');
                let decodeTime = tfdtBox ? parseTfdt(tfdtBox.data) : 0;
                let runDataCursorAbs = null;

                if (!tracks.has(trackId)) {
                    const meta = trackMetadata.get(trackId) || {};
                    tracks.set(trackId, {
                        trackId,
                        timescale: meta.timescale || 90000,
                        handlerType: meta.handlerType || 'unknown',
                        samples: [],
                        chunkOffsets: [],
                        mediaTime: 0,
                        playbackDuration: 0,
                        editShift: meta.editShift || 0,
                    });
                }
                const track = tracks.get(trackId);

                for (const trafChild of trafChildren) {
                    if (trafChild.type !== 'trun') continue;
                    const { samples, dataOffset, flags } = parseTrun(trafChild.data, tfhd);
                    const runSize = samples.reduce((sum, sample) => sum + (sample.size || 0), 0);

                    let dataStartAbs;
                    if (flags & 0x1) {
                        const baseAbs = (tfhd.flags & 0x1) ? tfhd.baseDataOffset : moofStart;
                        dataStartAbs = baseAbs + dataOffset;
                    } else if (runDataCursorAbs !== null) {
                        dataStartAbs = runDataCursorAbs;
                    } else {
                        dataStartAbs = mdatContentStartAbs;
                    }

                    let sampleByteOffset = combinedMdatOffset + Math.max(0, dataStartAbs - mdatContentStartAbs);
                    for (const sample of samples) {
                        const dts = decodeTime;
                        const pts = dts + (sample.compositionTimeOffset || 0);
                        track.samples.push({
                            ...sample,
                            dts,
                            pts,
                            byteOffset: sampleByteOffset,
                        });
                        decodeTime += sample.duration || 0;
                        sampleByteOffset += sample.size || 0;
                    }

                    runDataCursorAbs = dataStartAbs + runSize;
                }
            }
        } else if (box.type === 'mdat') {
            const data = box.data.subarray(8);
            mdatChunks.push({ data, offset: combinedMdatOffset });
            combinedMdatOffset += data.byteLength;
        }
    }

    const combinedMdat = new Uint8Array(combinedMdatOffset);
    for (const chunk of mdatChunks) {
        combinedMdat.set(chunk.data, chunk.offset);
    }

    return { tracks, combinedMdat };
}

function rebuildMdatContent(tracks, trackOrder, sourceMdat) {
    const orderedTrackIds = trackOrder.filter((trackId) => tracks.has(trackId));
    for (const trackId of tracks.keys()) {
        if (!orderedTrackIds.includes(trackId)) orderedTrackIds.push(trackId);
    }

    let totalSize = 0;
    for (const trackId of orderedTrackIds) {
        const track = tracks.get(trackId);
        for (const sample of track.samples) totalSize += sample.size || 0;
    }

    const mdatData = new Uint8Array(totalSize);
    let writeOffset = 0;

    for (const trackId of orderedTrackIds) {
        const track = tracks.get(trackId);
        if (!track || !track.samples.length) {
            if (track) track.chunkOffsets = [];
            continue;
        }

        track.chunkOffsets = [{ offset: writeOffset, sampleCount: track.samples.length }];
        for (const sample of track.samples) {
            const start = sample.byteOffset || 0;
            const end = start + (sample.size || 0);
            if (start < 0 || end > sourceMdat.byteLength) {
                throw new Error(`Invalid sample byte range for track ${trackId}: ${start}-${end}`);
            }
            mdatData.set(sourceMdat.subarray(start, end), writeOffset);
            sample.byteOffset = writeOffset;
            writeOffset += sample.size || 0;
        }
    }

    return mdatData;
}

function calculateMovieDuration(tracks, movieTimescale) {
    let maxDuration = 0;
    for (const [, track] of tracks) {
        const fallback = Math.max(0, sumSampleDurations(track.samples) - (track.mediaTime || 0));
        const playbackDuration = track.playbackDuration > 0 ? track.playbackDuration : fallback;
        track.playbackDuration = playbackDuration;
        track.movieDuration = toMovieTimescale(playbackDuration, track.timescale, movieTimescale);
        track.emptyMovieDuration = track.emptyDuration
            ? toMovieTimescale(track.emptyDuration, track.timescale, movieTimescale)
            : 0;
        maxDuration = Math.max(maxDuration, track.emptyMovieDuration + track.movieDuration);
    }
    return maxDuration;
}

function rebuildMvhd(mvhdBox, duration) {
    const data = new Uint8Array(mvhdBox.data);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const version = data[8];
    const durationOffset = version === 0 ? 24 : 32;
    if (version === 0) {
        view.setUint32(durationOffset, duration);
    } else {
        view.setUint32(durationOffset, 0);
        view.setUint32(durationOffset + 4, duration);
    }
    return data;
}

function rebuildTkhd(tkhdBox, trackInfo, maxMovieDuration) {
    const data = new Uint8Array(tkhdBox.data);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const version = data[8];
    const duration = trackInfo?.movieDuration != null
        ? trackInfo.movieDuration + (trackInfo.emptyMovieDuration || 0)
        : maxMovieDuration;
    if (version === 0) view.setUint32(28, duration);
    else {
        view.setUint32(36, 0);
        view.setUint32(40, duration);
    }
    return data;
}

function rebuildMdhd(mdhdBox, trackInfo) {
    const data = new Uint8Array(mdhdBox.data);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const version = data[8];
    const duration = sumSampleDurations(trackInfo?.samples || []);
    const durationOffset = version === 0 ? 24 : 32;
    if (version === 0) {
        view.setUint32(durationOffset, duration);
    } else {
        view.setUint32(durationOffset, 0);
        view.setUint32(durationOffset + 4, duration);
    }
    return data;
}

function rebuildStbl(stblBox, trackInfo) {
    const stblChildren = parseChildBoxes(stblBox);
    const newParts = [];
    for (const child of stblChildren) {
        if (child.type === 'stsd') {
            newParts.push(child.data);
            break;
        }
    }

    const samples = trackInfo?.samples || [];
    const chunkOffsets = trackInfo?.chunkOffsets || [];

    // stts
    const sttsEntries = [];
    let currentDuration = null;
    let currentCount = 0;
    for (const sample of samples) {
        const duration = sample.duration || 0;
        if (duration === currentDuration) currentCount++;
        else {
            if (currentDuration !== null) {
                sttsEntries.push({ count: currentCount, duration: currentDuration });
            }
            currentDuration = duration;
            currentCount = 1;
        }
    }
    if (currentDuration !== null) {
        sttsEntries.push({ count: currentCount, duration: currentDuration });
    }
    const sttsData = new Uint8Array(8 + sttsEntries.length * 8);
    const sttsView = new DataView(sttsData.buffer);
    sttsView.setUint32(4, sttsEntries.length);
    let offset = 8;
    for (const entry of sttsEntries) {
        sttsView.setUint32(offset, entry.count);
        sttsView.setUint32(offset + 4, entry.duration);
        offset += 8;
    }
    newParts.push(createBox('stts', sttsData));

    // stsc
    const stscEntries = [];
    if (chunkOffsets.length > 0) {
        let currentSampleCount = chunkOffsets[0].sampleCount;
        let firstChunk = 1;
        for (let i = 1; i <= chunkOffsets.length; i++) {
            const sampleCount = i < chunkOffsets.length ? chunkOffsets[i].sampleCount : -1;
            if (sampleCount !== currentSampleCount) {
                stscEntries.push({
                    firstChunk,
                    samplesPerChunk: currentSampleCount,
                    sampleDescriptionIndex: 1,
                });
                firstChunk = i + 1;
                currentSampleCount = sampleCount;
            }
        }
    }
    const stscData = new Uint8Array(8 + stscEntries.length * 12);
    const stscView = new DataView(stscData.buffer);
    stscView.setUint32(4, stscEntries.length);
    offset = 8;
    for (const entry of stscEntries) {
        stscView.setUint32(offset, entry.firstChunk);
        stscView.setUint32(offset + 4, entry.samplesPerChunk);
        stscView.setUint32(offset + 8, entry.sampleDescriptionIndex);
        offset += 12;
    }
    newParts.push(createBox('stsc', stscData));

    // stsz
    const stszData = new Uint8Array(12 + samples.length * 4);
    const stszView = new DataView(stszData.buffer);
    stszView.setUint32(8, samples.length);
    offset = 12;
    for (const sample of samples) {
        stszView.setUint32(offset, sample.size || 0);
        offset += 4;
    }
    newParts.push(createBox('stsz', stszData));

    // stco
    const stcoData = new Uint8Array(8 + chunkOffsets.length * 4);
    const stcoView = new DataView(stcoData.buffer);
    stcoView.setUint32(4, chunkOffsets.length);
    for (let i = 0; i < chunkOffsets.length; i++) {
        stcoView.setUint32(8 + i * 4, chunkOffsets[i].offset || 0);
    }
    newParts.push(createBox('stco', stcoData));

    // ctts
    const hasCtts = samples.some((sample) => sample.compositionTimeOffset);
    if (hasCtts) {
        const cttsEntries = [];
        let currentOffset = null;
        currentCount = 0;
        for (const sample of samples) {
            const compositionOffset = sample.compositionTimeOffset || 0;
            if (compositionOffset === currentOffset) currentCount++;
            else {
                if (currentOffset !== null) {
                    cttsEntries.push({ count: currentCount, offset: currentOffset });
                }
                currentOffset = compositionOffset;
                currentCount = 1;
            }
        }
        if (currentOffset !== null) {
            cttsEntries.push({ count: currentCount, offset: currentOffset });
        }
        const cttsData = new Uint8Array(8 + cttsEntries.length * 8);
        const cttsView = new DataView(cttsData.buffer);
        // Negative offsets need version 1 (signed)
        if (cttsEntries.some((entry) => entry.offset < 0)) cttsData[0] = 1;
        cttsView.setUint32(4, cttsEntries.length);
        offset = 8;
        for (const entry of cttsEntries) {
            cttsView.setUint32(offset, entry.count);
            cttsView.setInt32(offset + 4, entry.offset);
            offset += 8;
        }
        newParts.push(createBox('ctts', cttsData));
    }

    // stss (video sync samples)
    const syncSamples = [];
    for (let i = 0; i < samples.length; i++) {
        if (isSyncSample(samples[i])) syncSamples.push(i + 1);
    }
    if (syncSamples.length > 0 && syncSamples.length < samples.length) {
        const stssData = new Uint8Array(8 + syncSamples.length * 4);
        const stssView = new DataView(stssData.buffer);
        stssView.setUint32(4, syncSamples.length);
        offset = 8;
        for (const sampleNumber of syncSamples) {
            stssView.setUint32(offset, sampleNumber);
            offset += 4;
        }
        newParts.push(createBox('stss', stssData));
    }

    return createBox('stbl', ...newParts);
}

function rebuildMinf(minfBox, trackInfo) {
    const minfChildren = parseChildBoxes(minfBox);
    const newParts = [];
    for (const child of minfChildren) {
        if (child.type === 'stbl') newParts.push(rebuildStbl(child, trackInfo));
        else newParts.push(child.data);
    }
    return createBox('minf', ...newParts);
}

function rebuildMdia(mdiaBox, trackInfo) {
    const mdiaChildren = parseChildBoxes(mdiaBox);
    const newParts = [];
    for (const child of mdiaChildren) {
        if (child.type === 'minf') newParts.push(rebuildMinf(child, trackInfo));
        else if (child.type === 'mdhd') newParts.push(rebuildMdhd(child, trackInfo));
        else newParts.push(child.data);
    }
    return createBox('mdia', ...newParts);
}

function rebuildTrak(trakBox, trackInfoMap, maxMovieDuration) {
    const trakChildren = parseChildBoxes(trakBox);
    let trackId = null;
    for (const child of trakChildren) {
        if (child.type !== 'tkhd') continue;
        const view = new DataView(child.data.buffer, child.data.byteOffset, child.data.byteLength);
        trackId = child.data[8] === 0 ? view.getUint32(20) : view.getUint32(28);
    }
    if (trackId === null) return null;

    const trackInfo = trackInfoMap.get(trackId);
    if (!trackInfo || !trackInfo.samples.length) return null;

    const newParts = [];
    for (const child of trakChildren) {
        if (child.type === 'edts') continue;
        if (child.type === 'mdia') newParts.push(rebuildMdia(child, trackInfo));
        else if (child.type === 'tkhd') newParts.push(rebuildTkhd(child, trackInfo, maxMovieDuration));
        else newParts.push(child.data);
    }

    // An empty edit first when the track starts after the clip does
    const empty = trackInfo.emptyMovieDuration > 0 ? trackInfo.emptyMovieDuration : 0;
    const elstPayload = new Uint8Array(4 + (empty ? 24 : 12));
    const elstView = new DataView(elstPayload.buffer);
    elstView.setUint32(0, empty ? 2 : 1);
    let entry = 4;
    if (empty) {
        elstView.setUint32(entry, empty);
        elstView.setInt32(entry + 4, -1);
        elstView.setUint16(entry + 8, 1);
        entry += 12;
    }
    elstView.setUint32(entry, trackInfo.movieDuration ?? maxMovieDuration);
    elstView.setInt32(entry + 4, Math.max(0, Math.round(trackInfo.mediaTime || 0)));
    elstView.setUint16(entry + 8, 1);
    elstView.setUint16(entry + 10, 0);
    const elst = createFullBox('elst', 0, 0, elstPayload);
    const edts = createBox('edts', elst);

    const tkhdIndex = newParts.findIndex((part) =>
        part.length >= 8 && String.fromCharCode(part[4], part[5], part[6], part[7]) === 'tkhd',
    );
    if (tkhdIndex >= 0) newParts.splice(tkhdIndex + 1, 0, edts);
    else newParts.unshift(edts);

    return createBox('trak', ...newParts);
}

// ── Demuxed HLS audio: merge a separate audio-only fMP4 track ────────────────

/** Parse one fMP4 stream (init + fragments) into its ftyp/moov/tracks/mdat. */
function parseFmp4Source(fmp4Data) {
    const boxes = parseBoxes(fmp4Data);
    const ftyp = findBox(boxes, 'ftyp');
    const moov = findBox(boxes, 'moov');
    if (!ftyp || !moov) throw new Error('Invalid fMP4: missing ftyp or moov');
    const movieTimescale = getMovieTimescale(moov);
    const { trackMetadata, trackOrder } = extractTrackMetadata(moov);
    const trexDefaults = extractTrexDefaults(moov);
    const { tracks, combinedMdat } = collectTrackSamples(boxes, trackMetadata, trexDefaults);
    return { ftyp, moov, movieTimescale, tracks, combinedMdat };
}

function readTrakId(trakBox) {
    for (const c of parseChildBoxes(trakBox)) {
        if (c.type !== 'tkhd') continue;
        const view = new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);
        return c.data[8] === 0 ? view.getUint32(20) : view.getUint32(28);
    }
    return null;
}

/** Copy a trak box and overwrite its tkhd track_id (avoids id collisions when
 *  merging two independently-authored init segments). */
function cloneTrakWithId(trakBox, newId) {
    const data = new Uint8Array(trakBox.data);
    for (const c of parseBoxes(data, 8, data.length)) {
        if (c.type !== 'tkhd') continue;
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const idOff = c.offset + (data[c.offset + 8] === 0 ? 20 : 28);
        view.setUint32(idOff, newId);
        break;
    }
    return { type: 'trak', data, size: data.length };
}

/** Like rebuildMdatContent but each track reads from its own source mdat. */
function rebuildMdatMultiSource(tracks, trackOrder, trackToMdat) {
    const ordered = trackOrder.filter((id) => tracks.has(id));
    for (const id of tracks.keys()) if (!ordered.includes(id)) ordered.push(id);
    let total = 0;
    for (const id of ordered) for (const s of tracks.get(id).samples) total += s.size || 0;
    const mdat = new Uint8Array(total);
    let w = 0;
    for (const id of ordered) {
        const track = tracks.get(id);
        const src = trackToMdat.get(id);
        if (!track || !track.samples.length) { if (track) track.chunkOffsets = []; continue; }
        track.chunkOffsets = [{ offset: w, sampleCount: track.samples.length }];
        for (const s of track.samples) {
            const start = s.byteOffset || 0, end = start + (s.size || 0);
            if (start < 0 || end > src.byteLength) {
                throw new Error(`Invalid sample byte range for track ${id}: ${start}-${end}`);
            }
            mdat.set(src.subarray(start, end), w);
            s.byteOffset = w; w += s.size || 0;
        }
    }
    return mdat;
}

/**
 * Align separate video/audio tracks onto one timeline and trim audio to the
 * video's extent. The two renditions share the source clock but have their own
 * segment boundaries, so audio can lead the first video frame (measured ~0.94s).
 * We shift everything so video starts at 0 and drop audio before/after video —
 * the fMP4 stts is duration-based (starts each track at output-0), so a residual
 * offset can't be carried in the sample table and must be removed here.
 */
function alignSeparateTracks(tracks) {
    let vTrack = null;
    for (const [, t] of tracks) {
        if (t.handlerType === 'vide' && t.samples.length) { vTrack = t; break; }
    }
    if (!vTrack) {
        for (const [, t] of tracks) {
            if (!t.samples.length) continue;
            t.samples = normalizeSamples(t.samples, t.samples[0].dts || 0);
            t.mediaTime = 0;
            t.playbackDuration = sumSampleDurations(t.samples);
        }
        return;
    }
    const vStartSec = (vTrack.samples[0].dts || 0) / vTrack.timescale;
    const vLast = vTrack.samples[vTrack.samples.length - 1];
    const vEndSec = ((vLast.dts || 0) + (vLast.duration || 0)) / vTrack.timescale;

    for (const [, t] of tracks) {
        if (!t.samples.length) continue;
        const shift = Math.round(vStartSec * t.timescale);
        let samples = t.samples.map((s) => ({ ...s, dts: (s.dts || 0) - shift, pts: (s.pts || 0) - shift }));
        if (t !== vTrack) {
            // keep one extra frame of pad on the tail so audio fully covers video
            const endTick = Math.round((vEndSec - vStartSec) * t.timescale) + (samples[0]?.duration || 0);
            samples = samples.filter((s) => (s.dts || 0) >= 0 && (s.dts || 0) < endTick);
        }
        t.samples = samples;
        t.mediaTime = 0;
        t.playbackDuration = sumSampleDurations(samples);
    }
}

/**
 * Convert fMP4 video + a SEPARATE fMP4 audio rendition (demuxed HLS
 * #EXT-X-MEDIA:TYPE=AUDIO) into one MP4 with both tracks. Without this, CMAF
 * downloads (the production default) are silent. Discontinuities need no special
 * handling here — the fMP4 sample table is duration-based, so edited timelines
 * stay continuous by construction.
 */
export function convertFmp4WithSeparateAudio(videoFmp4, audioFmp4, options = {}) {
    const vsrc = parseFmp4Source(videoFmp4);
    const asrc = parseFmp4Source(audioFmp4);

    const combined = new Map();
    const trackToMdat = new Map();
    const trakBoxes = new Map();
    const order = [];
    let nextId = 1;

    for (const src of [vsrc, asrc]) {
        const srcTraks = parseChildBoxes(src.moov).filter((c) => c.type === 'trak');
        for (const [oldId, track] of src.tracks) {
            if (!track.samples.length) continue;
            const newId = nextId++;
            track.trackId = newId;
            combined.set(newId, track);
            trackToMdat.set(newId, src.combinedMdat);
            order.push(newId);
            const orig = srcTraks.find((t) => readTrakId(t) === oldId) || srcTraks[0];
            trakBoxes.set(newId, cloneTrakWithId(orig, newId));
        }
    }
    if (combined.size === 0) throw new Error('Separate-audio fMP4: no tracks found');

    alignSeparateTracks(combined);

    const hasClip = Number.isFinite(options.startTime) || Number.isFinite(options.endTime);
    const finalTracks = hasClip ? applyClipToTracks(combined, options) : combined;
    if (finalTracks.size === 0) throw new Error('Clip range produced no samples');

    const rebuiltMdat = rebuildMdatMultiSource(finalTracks, order, trackToMdat);
    const movieTimescale = vsrc.movieTimescale;
    const maxMovieDuration = calculateMovieDuration(finalTracks, movieTimescale);

    const mvhdBox = findBox(parseChildBoxes(vsrc.moov), 'mvhd');
    const parts = [];
    if (mvhdBox) {
        const mvhd = rebuildMvhd(mvhdBox, maxMovieDuration);
        new DataView(mvhd.buffer, mvhd.byteOffset, mvhd.byteLength).setUint32(mvhd.length - 4, nextId);
        parts.push(mvhd);
    }
    for (const newId of order) {
        if (!finalTracks.has(newId)) continue;
        const trak = rebuildTrak(trakBoxes.get(newId), finalTracks, maxMovieDuration);
        if (trak) parts.push(trak);
    }

    const newMoov = createBox('moov', ...parts);
    const newMdat = createBox('mdat', rebuiltMdat);
    const output = new Uint8Array(vsrc.ftyp.size + newMoov.byteLength + newMdat.byteLength);
    output.set(vsrc.ftyp.data, 0);
    output.set(newMoov, vsrc.ftyp.size);
    output.set(newMdat, vsrc.ftyp.size + newMoov.byteLength);
    updateStcoOffsets(output, vsrc.ftyp.size, newMoov.byteLength);
    return output;
}

function updateStcoOffsets(output, ftypSize, moovSize) {
    const mdatContentOffset = ftypSize + moovSize + 8;
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);

    function scan(start, end) {
        let position = start;
        while (position + 8 <= end) {
            const size = view.getUint32(position);
            if (size < 8) break;
            const type = String.fromCharCode(
                output[position + 4],
                output[position + 5],
                output[position + 6],
                output[position + 7],
            );

            if (type === 'stco') {
                const entryCount = view.getUint32(position + 12);
                for (let i = 0; i < entryCount; i++) {
                    const entryPos = position + 16 + i * 4;
                    const relativeOffset = view.getUint32(entryPos);
                    view.setUint32(entryPos, mdatContentOffset + relativeOffset);
                }
            } else if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) {
                scan(position + 8, position + size);
            }

            position += size;
        }
    }

    scan(0, output.byteLength);
}

/**
 * Convert fragmented MP4 to standard MP4
 * @param {Uint8Array} fmp4Data - fMP4 data
 * @param {object} [options] - Optional clip settings
 * @param {number} [options.startTime] - Clip start time (seconds)
 * @param {number} [options.endTime] - Clip end time (seconds)
 * @returns {Uint8Array} Standard MP4 data
 */
// Shared rebuild functions — also used by mp4-clip.js and the streaming muxer
export {
    applyClipToTracks,
    rebuildMdatContent,
    calculateMovieDuration,
    rebuildTrak,
    rebuildMvhd,
    updateStcoOffsets,
    extractTrackMetadata,
    extractTrexDefaults,
    collectTrackSamples,
    alignSeparateTracks,
    cloneTrakWithId,
    readTrakId,
};

export function convertFmp4ToMp4(fmp4Data, options = {}) {
    const boxes = parseBoxes(fmp4Data);
    const ftyp = findBox(boxes, 'ftyp');
    const moov = findBox(boxes, 'moov');
    if (!ftyp || !moov) throw new Error('Invalid fMP4: missing ftyp or moov');

    const movieTimescale = getMovieTimescale(moov);
    const { trackMetadata, trackOrder } = extractTrackMetadata(moov);
    const trexDefaults = extractTrexDefaults(moov);
    const { tracks, combinedMdat } = collectTrackSamples(boxes, trackMetadata, trexDefaults);

    if (tracks.size === 0) throw new Error('Invalid fMP4: no track fragments found');

    const clippedTracks = applyClipToTracks(tracks, options);
    if (clippedTracks.size === 0) {
        throw new Error('Clip range produced no samples');
    }

    const rebuiltMdat = rebuildMdatContent(clippedTracks, trackOrder, combinedMdat);
    const maxMovieDuration = calculateMovieDuration(clippedTracks, movieTimescale);

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

    const newMoov = createBox('moov', ...newMoovParts);
    const newMdat = createBox('mdat', rebuiltMdat);
    const output = new Uint8Array(ftyp.size + newMoov.byteLength + newMdat.byteLength);
    output.set(ftyp.data, 0);
    output.set(newMoov, ftyp.size);
    output.set(newMdat, ftyp.size + newMoov.byteLength);
    updateStcoOffsets(output, ftyp.size, newMoov.byteLength);
    return output;
}

export default convertFmp4ToMp4;
