# MPEG-TS Stitching Design

## Overview

Add the ability to stitch multiple MPEG-TS segments into either:
1. A single standard MP4 file (`stitchTs`)
2. A single continuous MPEG-TS stream (`concatTs`)

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                  stitchTs / concatTs                     │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │         parseAndCombineSegments() [SHARED]         │  │
│  │  - Parse each segment with TSParser                │  │
│  │  - Adjust timestamps for continuity                │  │
│  │  - Return combined videoAccessUnits + audioAUs     │  │
│  └────────────────────────────────────────────────────┘  │
│                          │                               │
│            ┌─────────────┴─────────────┐                │
│            ▼                           ▼                │
│     ┌─────────────┐            ┌─────────────┐          │
│     │  MP4Muxer   │            │  TSMuxer    │          │
│     │  (stitchTs) │            │ (concatTs)  │          │
│     └─────────────┘            └─────────────┘          │
│            │                           │                │
│            ▼                           ▼                │
│       Mp4Result                   Uint8Array            │
│                                   (raw TS)              │
└──────────────────────────────────────────────────────────┘
```

## Public API

### `toMp4.stitchTs(segments)` → Mp4Result

Stitch multiple MPEG-TS segments into a single MP4.

```js
const mp4 = toMp4.stitchTs([segment1, segment2, segment3]);
mp4.download('combined.mp4');
```

### `toMp4.concatTs(segments)` → Uint8Array

Concatenate multiple MPEG-TS segments into a single continuous TS stream.

```js
const tsData = toMp4.concatTs([segment1, segment2, segment3]);
```

## Implementation

### New Files

#### `src/mpegts/index.js`
Re-exports from stitcher.js

#### `src/mpegts/stitcher.js`

**`parseAndCombineSegments(segments)`** — Shared core logic:
- Parse each segment with TSParser
- Track running PTS/DTS offsets
- Offset each segment's timestamps to create continuity
- Return combined parser-like object with all access units

**`stitchTs(segments)`** — Public API:
- Call parseAndCombineSegments
- Feed to MP4Muxer
- Return Mp4Result

**`concatTs(segments)`** — Public API:
- Call parseAndCombineSegments
- Extract SPS/PPS from first keyframe
- Feed to TSMuxer with addVideoNalUnits method
- Return raw Uint8Array

### Modified Files

#### `src/index.js`
- Import stitchTs, concatTs from './mpegts/index.js'
- Attach to toMp4 function: `toMp4.stitchTs`, `toMp4.concatTs`
- Add to named exports

#### `src/muxers/mpegts.js`
- Add `addVideoNalUnits(nalUnits, isKey, pts, dts)` method
- Accepts Annex B NAL units directly (vs AVCC format)
- Used by concatTs for re-muxing parsed frames

#### `README.md`
- Add documentation for stitchTs and concatTs API

### Test Files

#### `tests/mpegts-stitch.test.js`
- Test stitchTs with multiple segments → MP4
- Test concatTs with multiple segments → TS
- Verify timestamp continuity
- Verify audio/video sync

## Implementation Steps

1. Create `src/mpegts/stitcher.js` with parseAndCombineSegments
2. Implement stitchTs (MP4 output)
3. Add addVideoNalUnits to TSMuxer
4. Implement concatTs (TS output)
5. Create `src/mpegts/index.js` with exports
6. Update `src/index.js` with imports and exports
7. Write tests
8. Update README
