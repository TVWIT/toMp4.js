# CLAUDE.md

## Project Overview

**@invintusmedia/tomp4** — Pure JavaScript library (~50kb minified) that converts MPEG-TS, fMP4, and HLS streams to standard MP4, and clips HLS to HLS (CMAF). Zero dependencies, works in browser and Node.js. Remuxing only (no transcoding).

## Quick Reference

- **Package**: `@invintusmedia/tomp4` (v1.2.1)
- **Repo**: TVWIT/toMp4.js
- **License**: MIT
- **Entry**: `src/index.js`
- **Types**: `src/index.d.ts`
- **Build**: `node build.js` (bundles to `dist/`)

## Commands

```bash
npm test              # Run all tests (hls-map, thumbnail, clip, mp4, av-sync, mp4-clip)
npm run test:clip     # MPEG-TS clipping tests
npm run test:fmp4-clip # fMP4 clipping tests
npm run test:mp4      # MP4 parser tests
npm run test:av-sync  # A/V sync regression tests
npm run test:mp4-clip # MP4-to-MP4 clipping tests
npm run build         # Bundle for distribution
npm run dev           # Local dev server on port 3000
```

## Architecture

```
src/
├── index.js              # Main API, format detection, Mp4Result class
├── index.d.ts            # TypeScript definitions
├── ts-to-mp4.js          # MPEG-TS → MP4 conversion + clipping logic
├── transcode.js          # WebCodecs transcoding (browser-only)
├── hls.js                # HLS manifest parsing and segment downloading
├── hls-clip.js           # HLS-to-HLS clipper (CMAF output with edit lists)
├── mp4-clip.js           # Standard MP4-to-MP4 clipper
├── thumbnail.js          # Video thumbnail extraction (browser-only)
├── remote/               # On-demand HLS serving from remote MP4 files
├── fmp4/
│   ├── index.js          # fMP4 module entry
│   ├── converter.js      # fMP4 → MP4 conversion + sample-level clipping
│   ├── stitcher.js       # Stitch multiple fMP4 segments into one MP4
│   └── utils.js          # MP4 box parsing/creation utilities
├── muxers/
│   ├── mp4.js            # MP4 muxer (builds moov, tracks, edit lists)
│   ├── fmp4.js           # fMP4/CMAF fragment muxer (init segments + moof/mdat)
│   └── mpegts.js         # MPEG-TS muxer
├── parsers/
│   ├── mp4.js            # MP4 parser (reads moov, samples, segments)
│   └── mpegts.js         # MPEG-TS demuxer (PAT/PMT/PES parsing)
└── mpegts/
    ├── index.js          # MPEG-TS stitching entry
    └── stitcher.js       # Stitch multiple TS segments
```

## Key Design Decisions

### Frame-Accurate Clipping (not keyframe-only)

Clipping uses MP4 Edit Lists (`elst` boxes) for frame-accurate cuts without re-encoding:

1. **Decode start**: Snaps back to nearest keyframe before requested `startTime` (required by H.264/H.265 decoders)
2. **Edit list**: Sets `media_time` to the preroll duration, telling the player to skip past keyframe-to-start frames
3. **Result**: Player shows exactly the requested time range

Four clipping paths, all frame-accurate:
- **MPEG-TS → MP4**: `clipAccessUnits()` in `ts-to-mp4.js` → `buildVideoEdts()` in `muxers/mp4.js`
- **fMP4 → MP4**: `clipVideoSamples()` in `fmp4/converter.js` → `rebuildTrak()` writes `elst`
- **MP4 → MP4**: `clipMp4()` in `mp4-clip.js` (parses with MP4Parser, reuses fMP4 rebuild pipeline)
- **HLS → HLS**: `clipHls()` in `hls-clip.js` (outputs CMAF/fMP4 segments with edit lists on boundaries)

### A/V Sync

Audio and video are always on the same timeline. When there's preroll (clip between keyframes), audio is included from the keyframe time — not the requested start — so both tracks have matching durations. Both get edit lists with the same preroll offset. This ensures A/V sync even on players that ignore edit lists.

### HLS-to-HLS Clipping

`clipHls()` produces a new HLS stream with CMAF (fMP4) segments:
- **Boundary segments** (first/last): pre-clipped with edit lists, served from memory
- **Middle segments**: original CDN URLs, remuxed TS→fMP4 on-demand (~2-5ms overhead)
- Frame accuracy via edit lists in the fMP4 container (TS has no edit list mechanism)
- Supports ABR (processes all quality variants)

### Supported Codecs

| Type | Supported | Stream Type IDs |
|------|-----------|----------------|
| H.264/AVC | Yes | 0x1B |
| H.265/HEVC | Yes | 0x24 |
| AAC | Yes | 0x0F |
| AAC-LATM | Yes | 0x11 |
| MPEG-1/2, MP3, AC-3 | No (requires transcoding) | — |

### No External Dependencies

Everything is pure JavaScript — no ffmpeg, no wasm, no native modules. The library parses container formats and remuxes raw codec data into MP4 boxes directly.

## Conventions

- ESM modules (`"type": "module"` in package.json)
- Tests use plain `node:assert` and `node:test` — no test framework
- Test fixtures are generated programmatically (synthetic TS/fMP4 data)
- Release flow: `npm run release:patch` (bumps version, tests, builds, commits, tags, pushes)
