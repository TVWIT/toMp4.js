import { __test__ } from '../src/thumbnail.js';

const { buildFrameTimeline, pickFrame } = __test__;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Synthetic 30fps stream, 10 frames. PTS in 90kHz ticks: 0, 3000, 6000, ...
const fakeParser30 = {
  videoAccessUnits: Array.from({ length: 10 }, (_, i) => ({ pts: i * 3000 })),
};
const tl30 = buildFrameTimeline(fakeParser30);
assert(tl30.length === 10, 'expected 10 frames');
assert(Math.abs(tl30[0].startSec - 0) < 1e-9, 'first frame starts at 0');
assert(Math.abs(tl30[1].startSec - 1 / 30) < 1e-9, 'second frame at 1/30s');
assert(Math.abs(tl30[9].endSec - tl30[9].startSec - 1 / 30) < 1e-9, 'last frame uses prior duration');

// Snap-back: target inside frame i must pick frame i.
assert(pickFrame(tl30, 0) === 0, 'target=0 → frame 0');
assert(pickFrame(tl30, 1 / 60) === 0, 'target=halfway through frame 0 → frame 0');
assert(pickFrame(tl30, 1 / 30) === 1, 'target=start of frame 1 → frame 1');
assert(pickFrame(tl30, 1 / 30 + 1e-9) === 1, 'target just past frame 1 start → frame 1');
assert(pickFrame(tl30, 5 / 30 - 1e-9) === 4, 'target just before frame 5 → frame 4');
assert(pickFrame(tl30, 100) === 9, 'target past end → last frame');

// Targets before t=0 should clamp to first frame, not return -1.
assert(pickFrame(tl30, -1) === 0, 'negative target → frame 0');

// B-frames: PTS arrives out of decode order. After parser.normalizeTimestamps,
// the smallest PTS becomes 0, and we sort by PTS to get display order.
// Decode order I, P, B, B, P, B, B → PTS 0, 9000, 3000, 6000, 18000, 12000, 15000
const fakeParserB = {
  videoAccessUnits: [
    { pts: 0 },     // I
    { pts: 9000 },  // P
    { pts: 3000 },  // B
    { pts: 6000 },  // B
    { pts: 18000 }, // P
    { pts: 12000 }, // B
    { pts: 15000 }, // B
  ],
};
const tlB = buildFrameTimeline(fakeParserB);
const startsB = tlB.map((f) => f.startSec);
const sorted = [...startsB].every((s, i, a) => i === 0 || a[i - 1] <= s);
assert(sorted, 'timeline is sorted by display time');
// Frame between PTS 6000 and 9000 (i.e. ~0.078s) should pick the frame at 6000.
assert(pickFrame(tlB, 0.075) === 2, 'target inside frame@6000 picks display index 2');
assert(pickFrame(tlB, 6000 / 90000) === 2, 'target exactly on frame@6000 boundary picks it');
assert(pickFrame(tlB, 9000 / 90000) === 3, 'target on frame@9000 boundary picks frame@9000');

// Empty timeline returns -1.
assert(pickFrame(buildFrameTimeline({ videoAccessUnits: [] }), 1) === -1, 'empty timeline → -1');

console.log('thumbnail-frame-pick: all assertions passed');
