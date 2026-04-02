/**
 * H.264 Intra Prediction
 *
 * Implements Intra 4x4, Intra 8x8, and Intra 16x16 prediction modes
 * for luma and chroma. Used during macroblock decoding to reconstruct
 * the predicted block from neighboring samples.
 *
 * Reference: ITU-T H.264, Section 8.3
 *
 * @module codecs/h264-intra
 */

import { clip255 } from './h264-transform.js';

// ══════════════════════════════════════════════════════════
// Intra 4x4 Prediction (Section 8.3.1.2)
// 9 modes for each 4x4 luma block
// ══════════════════════════════════════════════════════════

/**
 * Perform Intra 4x4 prediction.
 * @param {number} mode - Prediction mode (0-8)
 * @param {Int32Array|null} above - 8 samples above (indices 0-3 = directly above, 4-7 = above-right)
 * @param {Int32Array|null} left - 4 samples to the left
 * @param {number} aboveLeft - Above-left corner sample
 * @param {boolean} hasAbove - Whether above samples are available
 * @param {boolean} hasLeft - Whether left samples are available
 * @param {boolean} hasAboveRight - Whether above-right samples are available
 * @returns {Int32Array} 16-element predicted block in raster order
 */
export function intra4x4Predict(mode, above, left, aboveLeft, hasAbove, hasLeft, hasAboveRight) {
  const pred = new Int32Array(16);

  // Extend above samples: if above-right not available, repeat the last above sample
  const p = new Int32Array(13); // p[-1..7] mapped to p[0..12] (index offset: +1)
  // p[0] = above-left, p[1..4] = above[0..3], p[5..8] = above-right[0..3]
  if (hasAbove) {
    for (let i = 0; i < 4; i++) p[i + 1] = above[i];
    if (hasAboveRight) {
      for (let i = 0; i < 4; i++) p[i + 5] = above[i + 4];
    } else {
      for (let i = 0; i < 4; i++) p[i + 5] = above[3];
    }
  }
  p[0] = hasAbove && hasLeft ? aboveLeft : hasAbove ? above[0] : hasLeft ? left[0] : 128;

  const l = left || new Int32Array(4); // left[0..3]

  switch (mode) {
    case 0: // Vertical
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++)
          pred[y * 4 + x] = p[x + 1];
      break;

    case 1: // Horizontal
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++)
          pred[y * 4 + x] = l[y];
      break;

    case 2: { // DC
      let sum = 0, count = 0;
      if (hasAbove) { for (let i = 0; i < 4; i++) sum += p[i + 1]; count += 4; }
      if (hasLeft) { for (let i = 0; i < 4; i++) sum += l[i]; count += 4; }
      const dc = count > 0 ? (sum + (count >> 1)) / count | 0 : 128;
      pred.fill(dc);
      break;
    }

    case 3: // Diagonal Down-Left
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          if (x === 3 && y === 3)
            pred[y * 4 + x] = (p[6] + 3 * p[7] + 2) >> 2;
          else
            pred[y * 4 + x] = (p[x + y + 1] + 2 * p[x + y + 2] + p[x + y + 3] + 2) >> 2;
        }
      break;

    case 4: // Diagonal Down-Right
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          if (x > y)
            pred[y * 4 + x] = (p[x - y] + 2 * p[x - y + 1] + p[x - y + 2] + 2) >> 2;
          else if (x < y)
            pred[y * 4 + x] = (l[y - x - 1] + 2 * (x === 0 && y - 1 >= 0 ? l[y - 1] : l[y - x - 1]) + (y - x >= 2 ? l[y - x - 2] : p[0]) + 2) >> 2;
          else // x === y
            pred[y * 4 + x] = (p[1] + 2 * p[0] + l[0] + 2) >> 2;
        }
      break;

    // Modes 5-8 are less common; implement with the standard filter formulas
    case 5: // Vertical-Right
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          const zVR = 2 * x - y;
          if (zVR >= 0 && (zVR & 1) === 0)
            pred[y * 4 + x] = (p[(zVR >> 1)] + p[(zVR >> 1) + 1] + 1) >> 1;
          else if (zVR >= 0)
            pred[y * 4 + x] = (p[(zVR >> 1)] + 2 * p[(zVR >> 1) + 1] + p[(zVR >> 1) + 2] + 2) >> 2;
          else if (zVR === -1)
            pred[y * 4 + x] = (l[0] + 2 * p[0] + p[1] + 2) >> 2;
          else // zVR < -1
            pred[y * 4 + x] = (l[y - 1] + 2 * l[y - 2] + l[y - 3 >= 0 ? y - 3 : 0] + 2) >> 2;
        }
      break;

    case 6: // Horizontal-Down
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          const zHD = 2 * y - x;
          if (zHD >= 0 && (zHD & 1) === 0)
            pred[y * 4 + x] = zHD === 0
              ? (p[0] + l[0] + 1) >> 1
              : (l[(zHD >> 1) - 1] + l[zHD >> 1] + 1) >> 1;
          else if (zHD >= 0)
            pred[y * 4 + x] = zHD === 1
              ? (l[0] + 2 * p[0] + p[1] + 2) >> 2
              : (l[(zHD >> 1) - 1] + 2 * l[zHD >> 1] + l[(zHD >> 1) + 1 < 4 ? (zHD >> 1) + 1 : 3] + 2) >> 2;
          else if (zHD === -1)
            pred[y * 4 + x] = (p[0] + 2 * p[1] + p[2] + 2) >> 2;
          else
            pred[y * 4 + x] = (p[x - 1] + 2 * p[x] + p[x + 1] + 2) >> 2;
        }
      break;

    case 7: // Vertical-Left
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          if ((y & 1) === 0)
            pred[y * 4 + x] = (p[x + (y >> 1) + 1] + p[x + (y >> 1) + 2] + 1) >> 1;
          else
            pred[y * 4 + x] = (p[x + (y >> 1) + 1] + 2 * p[x + (y >> 1) + 2] + p[x + (y >> 1) + 3] + 2) >> 2;
        }
      break;

    case 8: // Horizontal-Up
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          const zHU = x + 2 * y;
          if (zHU < 5 && (zHU & 1) === 0)
            pred[y * 4 + x] = (l[zHU >> 1] + l[(zHU >> 1) + 1] + 1) >> 1;
          else if (zHU < 5)
            pred[y * 4 + x] = (l[zHU >> 1] + 2 * l[(zHU >> 1) + 1] + l[Math.min((zHU >> 1) + 2, 3)] + 2) >> 2;
          else if (zHU === 5)
            pred[y * 4 + x] = (l[2] + 3 * l[3] + 2) >> 2;
          else
            pred[y * 4 + x] = l[3];
        }
      break;
  }

  return pred;
}

// ══════════════════════════════════════════════════════════
// Intra 16x16 Prediction (Section 8.3.3)
// 4 modes for the full 16x16 luma block
// ══════════════════════════════════════════════════════════

/**
 * Perform Intra 16x16 prediction.
 * @param {number} mode - Prediction mode (0-3)
 * @param {Uint8Array} above - 16 samples above the macroblock
 * @param {Uint8Array} left - 16 samples to the left
 * @param {number} aboveLeft - Above-left corner sample
 * @param {boolean} hasAbove
 * @param {boolean} hasLeft
 * @returns {Int32Array} 256-element predicted block (16x16 raster)
 */
export function intra16x16Predict(mode, above, left, aboveLeft, hasAbove, hasLeft) {
  const pred = new Int32Array(256);

  switch (mode) {
    case 0: // Vertical
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++)
          pred[y * 16 + x] = above[x];
      break;

    case 1: // Horizontal
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++)
          pred[y * 16 + x] = left[y];
      break;

    case 2: { // DC
      let sum = 0, count = 0;
      if (hasAbove) { for (let i = 0; i < 16; i++) sum += above[i]; count += 16; }
      if (hasLeft) { for (let i = 0; i < 16; i++) sum += left[i]; count += 16; }
      const dc = count > 0 ? (sum + (count >> 1)) / count | 0 : 128;
      pred.fill(dc);
      break;
    }

    case 3: { // Plane
      let H = 0, V = 0;
      for (let i = 0; i < 8; i++) {
        H += (i + 1) * (above[8 + i] - above[6 - i]);
        V += (i + 1) * (left[8 + i] - left[6 - i]);
      }
      const a = 16 * (above[15] + left[15]);
      const b = (5 * H + 32) >> 6;
      const c = (5 * V + 32) >> 6;

      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++)
          pred[y * 16 + x] = clip255((a + b * (x - 7) + c * (y - 7) + 16) >> 5);
      break;
    }
  }

  return pred;
}

// ══════════════════════════════════════════════════════════
// Intra Chroma Prediction (Section 8.3.4)
// 4 modes for each 8x8 chroma block (4:2:0)
// ══════════════════════════════════════════════════════════

/**
 * Perform Intra chroma prediction (8x8 for 4:2:0).
 * @param {number} mode - 0=DC, 1=Horizontal, 2=Vertical, 3=Plane
 * @param {Uint8Array} above - 8 samples above
 * @param {Uint8Array} left - 8 samples to the left
 * @param {number} aboveLeft - Corner sample
 * @param {boolean} hasAbove
 * @param {boolean} hasLeft
 * @returns {Int32Array} 64-element predicted block (8x8 raster)
 */
export function intraChromaPredict(mode, above, left, aboveLeft, hasAbove, hasLeft) {
  const pred = new Int32Array(64);

  switch (mode) {
    case 0: { // DC (per 4x4 sub-block)
      for (let blkY = 0; blkY < 2; blkY++) {
        for (let blkX = 0; blkX < 2; blkX++) {
          let sum = 0, count = 0;
          const topAvail = hasAbove;
          const leftAvail = hasLeft;

          if (topAvail) {
            for (let i = 0; i < 4; i++) sum += above[blkX * 4 + i];
            count += 4;
          }
          if (leftAvail) {
            for (let i = 0; i < 4; i++) sum += left[blkY * 4 + i];
            count += 4;
          }

          const dc = count > 0 ? (sum + (count >> 1)) / count | 0 : 128;

          for (let y = 0; y < 4; y++)
            for (let x = 0; x < 4; x++)
              pred[(blkY * 4 + y) * 8 + blkX * 4 + x] = dc;
        }
      }
      break;
    }

    case 1: // Horizontal
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++)
          pred[y * 8 + x] = left[y];
      break;

    case 2: // Vertical
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++)
          pred[y * 8 + x] = above[x];
      break;

    case 3: { // Plane
      let H = 0, V = 0;
      for (let i = 0; i < 4; i++) {
        H += (i + 1) * (above[4 + i] - above[2 - i]);
        V += (i + 1) * (left[4 + i] - left[2 - i]);
      }
      const a = 16 * (above[7] + left[7]);
      const b = (17 * H + 16) >> 5;
      const c = (17 * V + 16) >> 5;

      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++)
          pred[y * 8 + x] = clip255((a + b * (x - 3) + c * (y - 3) + 16) >> 5);
      break;
    }
  }

  return pred;
}
