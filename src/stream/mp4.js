/**
 * Streaming MP4 muxer — writes ftyp + mdat + moov to a StreamTarget without
 * ever holding the whole file (or even the whole mdat) in memory. Segments are
 * pulled and their media bytes written one at a time; only the sample table
 * (small) accumulates. Layout is mdat-first with a 64-bit size that is patched
 * once the media length is known, so no second pass / re-fetch is needed.
 *
 * Covers the production case: demuxed CMAF (separate fMP4 video + audio
 * renditions). Discontinuities need no special handling (fMP4 stts is
 * duration-based). The output is a standard, widely-playable MP4.
 */
import { parseBoxes, findBox, parseChildBoxes, createBox, getMovieTimescale } from '../fmp4/utils.js';
import { parseHls, parsePlaylistText, resolveAudioRendition } from '../hls.js';
import {
  extractTrackMetadata, extractTrexDefaults, collectTrackSamples,
  alignSeparateTracks, cloneTrakWithId, readTrakId,
  calculateMovieDuration, rebuildTrak, rebuildMvhd,
} from '../fmp4/converter.js';

function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; }
function u64(n) { const b = new Uint8Array(8); const v = new DataView(b.buffer); v.setUint32(0, Math.floor(n / 2 ** 32)); v.setUint32(4, n >>> 0); return b; }

function parseInit(initBytes) {
  const boxes = parseBoxes(initBytes);
  const ftyp = findBox(boxes, 'ftyp');
  const moov = findBox(boxes, 'moov');
  if (!ftyp || !moov) throw new Error('Invalid fMP4 init: missing ftyp or moov');
  const { trackMetadata } = extractTrackMetadata(moov);
  return {
    ftyp, moov,
    movieTimescale: getMovieTimescale(moov),
    trackMetadata,
    trexDefaults: extractTrexDefaults(moov),
    traks: parseChildBoxes(moov).filter((c) => c.type === 'trak'),
  };
}

/**
 * @param {object} src
 * @param {Uint8Array} src.videoInit  - video rendition init segment
 * @param {Uint8Array} src.audioInit  - audio rendition init segment
 * @param {Iterable<Uint8Array>|AsyncIterable<Uint8Array>} src.videoSegments
 * @param {Iterable<Uint8Array>|AsyncIterable<Uint8Array>} src.audioSegments
 * @param {StreamTarget} target
 * @param {object} [options] - { onProgress }
 */
export async function streamFmp4SeparateAudio(src, target, options = {}) {
  const log = options.onProgress || (() => {});
  const v = parseInit(src.videoInit);
  const a = parseInit(src.audioInit);

  // ftyp
  await target.write(v.ftyp.data);

  // mdat with a 64-bit largesize placeholder: [size=1]['mdat'][largesize]
  const mdatStart = target.position;
  await target.write(u32(1));
  await target.write(new Uint8Array([0x6d, 0x64, 0x61, 0x74])); // 'mdat'
  await target.write(u64(0)); // largesize placeholder (patched at the end)

  const combined = new Map();       // newId -> track (accumulating samples)
  const trackToTrak = new Map();    // newId -> cloned trak box (id-remapped)
  const order = [];
  let nextId = 1;

  // Stream one rendition's segments into the mdat, appending to a combined track.
  async function streamRendition(init, segments, phase) {
    const localIds = new Map(); // oldId -> newId (created lazily on first sample)
    for await (const seg of segments) {
      const { tracks, combinedMdat } = collectTrackSamples(parseBoxes(seg), init.trackMetadata, init.trexDefaults);
      for (const [oldId, segTrack] of tracks) {
        if (!segTrack.samples.length) continue;
        let newId = localIds.get(oldId);
        if (newId === undefined) {
          newId = nextId++;
          localIds.set(oldId, newId);
          combined.set(newId, {
            trackId: newId, timescale: segTrack.timescale, handlerType: segTrack.handlerType,
            samples: [], chunkOffsets: [], mediaTime: 0, playbackDuration: 0,
          });
          order.push(newId);
          const orig = init.traks.find((t) => readTrakId(t) === oldId) || init.traks[0];
          trackToTrak.set(newId, cloneTrakWithId(orig, newId));
        }
        const track = combined.get(newId);
        for (const s of segTrack.samples) {
          const filePos = target.position;
          await target.write(combinedMdat.subarray(s.byteOffset, s.byteOffset + (s.size || 0)));
          track.samples.push({ size: s.size, dts: s.dts, pts: s.pts, duration: s.duration, byteOffset: filePos });
        }
      }
      log(`${phase}: ${combined.size ? [...combined.values()].reduce((n, t) => n + t.samples.length, 0) : 0} samples`, { phase });
    }
  }

  await streamRendition(v, src.videoSegments, 'video');
  await streamRendition(a, src.audioSegments, 'audio');

  const mdatEnd = target.position;
  const mdatSize = mdatEnd - mdatStart;

  if (combined.size === 0) throw new Error('streamFmp4SeparateAudio: no samples written');

  // Align the two renditions onto one timeline (trim audio to the video extent).
  alignSeparateTracks(combined);

  // Build moov with stco pointing at the absolute file positions we recorded.
  const movieTimescale = v.movieTimescale;
  const maxMovieDuration = calculateMovieDuration(combined, movieTimescale);
  for (const [, track] of combined) {
    if (!track.samples.length) continue;
    track.chunkOffsets = [{ offset: track.samples[0].byteOffset, sampleCount: track.samples.length }];
  }

  const mvhdBox = findBox(parseChildBoxes(v.moov), 'mvhd');
  const parts = [];
  if (mvhdBox) {
    const mvhd = rebuildMvhd(mvhdBox, maxMovieDuration);
    new DataView(mvhd.buffer, mvhd.byteOffset, mvhd.byteLength).setUint32(mvhd.length - 4, nextId);
    parts.push(mvhd);
  }
  for (const newId of order) {
    const track = combined.get(newId);
    if (!track || !track.samples.length) continue;
    const trak = rebuildTrak(trackToTrak.get(newId), combined, maxMovieDuration);
    if (trak) parts.push(trak);
  }
  const moov = createBox('moov', ...parts);
  await target.write(moov);

  // Patch the mdat largesize now that the media length is known.
  await target.writeAt(mdatStart + 8, u64(mdatSize));

  await target.close();
  log('complete', { phase: 'done' });
  return { bytes: mdatEnd + moov.length, tracks: combined.size };
}

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
async function* lazySegments(segments) {
  // fetch one segment at a time so only the current segment is resident
  for (const seg of segments) yield await fetchBytes(seg.url || seg);
}

/**
 * Stream a demuxed-CMAF HLS master straight to a StreamTarget as an MP4,
 * fetching segments lazily (bounded memory). Video variant is highest quality;
 * audio is the variant's referenced #EXT-X-MEDIA rendition.
 * @param {string} masterUrl
 * @param {StreamTarget} target
 * @param {object} [options] - { quality, onProgress }
 */
export async function streamHlsToMp4(masterUrl, target, options = {}) {
  const stream = await parseHls(masterUrl, options);
  if (options.quality) stream.select(options.quality);
  const variant = stream.selected;
  if (!variant) throw new Error('streamHlsToMp4: no variant in master playlist');
  const audio = resolveAudioRendition(stream, variant);
  if (!audio) throw new Error('streamHlsToMp4: no demuxed audio rendition (this path is for CMAF with a separate audio group)');

  const vMedia = parsePlaylistText(await (await fetch(variant.url)).text(), variant.url);
  const aMedia = parsePlaylistText(await (await fetch(audio.url)).text(), audio.url);
  if (!vMedia.initSegmentUrl || !aMedia.initSegmentUrl) {
    throw new Error('streamHlsToMp4: expected CMAF (EXT-X-MAP init segments) on both renditions');
  }
  const [videoInit, audioInit] = await Promise.all([fetchBytes(vMedia.initSegmentUrl), fetchBytes(aMedia.initSegmentUrl)]);
  return streamFmp4SeparateAudio({
    videoInit, audioInit,
    videoSegments: lazySegments(vMedia.segments),
    audioSegments: lazySegments(aMedia.segments),
  }, target, options);
}
