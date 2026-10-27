# OTFP-compatible HLS packager (failover for Fastly's On-the-Fly Packager)

> Status: PARKED (2026-10-27). Built and tested on `feat/otfp-packager`, never deployed: the Fastly OTFP
> outage was fixed at Fastly, so the failover isn't needed now. The library fixes found while building it
> shipped in tomp4 v1.8.0; this branch keeps the server, VCL and Docker files for reference.
> Incident record (hosted-player repo):
> `.claude/plans/hotfixes/20261026/vod-streamuri-404-fastly-no-healthy-backends.md`.

## Why

All Invintus VOD goes through Fastly's managed On-the-Fly Packager (OTFP):
`api.v3 /StreamURI/hls/{client}/{event}/media.m3u8` → `fastlyVod()` →
`invintus-otfp.global.ssl.fastly.net` / `svod.invintus.com`. On 2026-10-26 Fastly's packager backend
(`get_backend_otfp_vpop_mnz_https()` in the managed `otfp` snippet) went unhealthy: every VOD got
`503 No healthy backends`, which the API returned as a 404. The VCL's backups (`aws` / `imw` /
`ics`) only swap the storage the packager reads from, so they can't help when the packager itself is
down. We need a second HLS packager we control. Playback stays HLS: no direct MP4.

Bar: **our player (hls.js, and Safari native) plays it**, and it accepts the request URLs the API
and VCL already use. Byte-identical output to OTFP isn't required.

## URL contract (what the API / VCL send OTFP today)

| Request | OTFP behaviour | Ours |
|---|---|---|
| `/{dir}/{name}.m3u8` | Media playlist for origin `{dir}/{name}.mp4`; relative `{name}-{n}.ts` segment lines (n from 1). `PublicAPI` `parseAndReplaceManifest()` prepends the directory to every line containing `.ts` | Same, but segments are `{name}-tm{n}.ts` (relative) |
| `/{dir}/{a},{b},…/master.m3u8` | Master playlist; each variant is a file in `{dir}`; variant URLs **absolute** (`X-Fastly-Base-Url`), since the API serves the master from its own domain and only rewrites `.ts` lines | Same; variants are `{base}{x}-tm.m3u8` |
| `?start=&end=` on `.m3u8` | Time slice | Segment-level slice |
| `?subtitles=`, `?iframe`, `.mpd` | WebVTT rendition / I-frame playlists / DASH | Not supported (our player doesn't use them) |
| Missing source | 404, `X-Fastly-Package-Error: Origin 404` | 404, `X-Packager-Error: Origin 404` |

**Our own names (`-tm.m3u8`, `-tm{n}.ts`) let the VCL send a session back to the packager that made
its playlist.** OTFP's segment cut points and timestamps aren't known (it's down, and they aren't
documented). Serving our segments against an OTFP playlist, or the reverse, could glitch. So the VCL
always routes `-tm` names to us, and routes OTFP-style requests to us only when OTFP fails.

## Review of the existing demo (`src/remote`, `examples/node/hls-server.js`)

Tested against event 2026101011 (KTOO, 42:12, 720p, H.264 Main, AAC-LC, GOP 3.003 s). Bugs:

1. **A/V sync, ~79 ms audio early.** Edit lists (`edts/elst`) aren't parsed. The source shifts video
   by 0.1001 s (B-frame delay) and audio by 1024 samples (AAC priming); the TS kept raw media times.
   (`clipMp4` also ignores source edit lists: `mediaTime: 0`.)
2. **First 0.1 s of audio dropped.** Audio is assigned to segments by raw time against a video
   segment that starts at 0.1001.
3. **Negative `ctts` clamped** (`Math.max(dts, dts + off)`): wrong PTS for version-1 `ctts`; also
   feeds `clipMp4`'s composition offsets.
4. **Init is O(samples × keyframes).** `stss.includes()` runs per sample (76k × 844). Init took 5.5 s.
5. **Last video frame dropped** (`buildSegments` end index off by one; duration short by one frame).
6. **`EXT-X-TARGETDURATION` from the configured target, not the real max `EXTINF`.** It violates the
   HLS spec when GOP > target (Safari can reject the playlist).
7. **Master playlist lacks `CODECS`, `AVERAGE-BANDWIDTH`, `FRAME-RATE`; `BANDWIDTH` is video-only.**
8. **Segment fetch: video and audio ranges fetched separately, many requests per segment**
   (1.5–2.3 s per 3 s segment from B2).
9. **TS: NAL length size assumed 4; PCR only on keyframes** (every ~3 s).
10. **AAC profile assumed LC in ADTS; `esds` not parsed.**
11. **No caching, single source, demo routes only.**

## Design

- **Library fixes** (`src/parsers/mp4.js`, `src/muxers/mpegts.js`, `src/remote/index.js`) for 1–10,
  keeping `MP4Parser`/`buildSampleTable` sample times unchanged (edit info is exposed on the track;
  `RemoteMp4` applies it).
- **`packager/`** (in this repo, not in the npm `files`): zero-dependency Node HTTP server.
  - OTFP routes above, plus `/healthz`.
  - LRU of initialised sources with one shared init per source; origin fetches with timeout and retry.
  - OTFP-like status codes and cache headers; JSON logs.
  - Dockerfile.
- **Fastly**: a normal backend for the packager **with a health check** on `/healthz`.
  - `-tm` names always go to it.
  - OTFP-style playlists fail over to it when OTFP is unhealthy or returns 5xx.
  - A request header simulates the OTFP outage, for testing.

## Also fixed while reviewing

12. **`readUint32` signed** (values ≥ 2³¹ negative), **`readUint64` low word only** (files > 4 GB),
    **`readInt32` double-converted negatives** (garbage v1 `ctts`).
13. **`stsc` lookup O(chunks × entries)**: 2.5 s for an interleaved 42-min audio track with 66k entries
    (now 17 ms). Cold 5-rendition master went from 16 s to 2.6 s.
14. **TS muxer: frames under 176 bytes left zero bytes** instead of adaptation-field stuffing
    (corrupt small P-frames, e.g. static slides at 160p).
15. **`clipMp4` A/V sync** (clip downloads): source edit lists ignored, and audio got the video's
    preroll instead of its own, giving −21 to +51 ms depending on the cut point. Now exact. Starts
    inside a frame snap to that frame's start for both tracks (players round mid-frame edits
    differently).

## Status

- [x] Library fixes + tests (`tests/remote-hls.test.js`: 17; each fix mutation-checked)
- [x] Packager server + tests (`packager/`, `tests/packager.test.js`: 13)
- [x] Verified against event 2026101011 from B2: A/V alignment matches the source; every audio/video
      frame in exactly one segment; hosted-player `?src=` plays from 0:00 and after a seek to 21:06
- [x] Fastly VCL failover + simulation header (`packager/fastly/`). **Not compiled yet**: needs
      Fastly's Validate
- [x] Deploy notes (`packager/README.md`, `packager/fastly/README.md`). Docker image not built yet
      (daemon wasn't running)
- [ ] Deploy the packager; set up the Fastly backend, health check and dictionary; validate and
      activate the VCL
- [ ] Safari / iOS native HLS check

Pre-existing, unrelated: `tests/hls-clip.test.js` (not in `npm test`) fails 6/8 against the current
`clipHls` API, the same with or without these changes.

## Review before the v1.8.0 release (2026-10-27)

Two independent reviews plus an old-vs-new harness (every public path on generated B-frame + AAC
media; content matched by frame MD5 / packet hash) found more, all fixed in v1.8.0:

- The same edit-list problem in the TS and fMP4/CMAF clip paths (hosted-player clip downloads): TS
  clips started 2 frames early with 45–59 ms of audio lead; muxed CMAF HLS clips came out on the
  wrong range (relative to the fMP4's absolute decode time). All clip paths now start on the frame
  containing the start with 0.0 ms A/V offset (`tests/clip-sync.test.js`).
- Regressions in this branch's first pass: version-0 `ctts` read unsigned (huge PTS); clips in the
  last B-frame window came out empty. Fixed.
- `RemoteMp4`: cross-origin use (hidden Content-Range), connection leaks on errors, silent
  truncation with Range-ignoring origins, under-declared BANDWIDTH, API breaks against 1.7. Fixed;
  the 1.7 segment rule stays the default (`segmentBoundary: 'after'` is the ffmpeg/OTFP rule the
  packager uses).
