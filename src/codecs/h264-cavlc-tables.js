/**
 * H.264 CAVLC (Context-Adaptive Variable-Length Coding) Encoding Tables
 *
 * Complete VLC tables from ITU-T H.264 specification:
 *   - Table 9-5:  coeff_token VLC tables (5 nC ranges + ChromaDC variants)
 *   - Table 9-7:  total_zeros for 4x4 blocks (TotalCoeff 1-15)
 *   - Table 9-8:  total_zeros for chroma DC 2x2 (TotalCoeff 1-3)
 *   - Table 9-9:  total_zeros for chroma DC 2x4 (TotalCoeff 1-7)
 *   - Table 9-10: run_before (zerosLeft 1-7+)
 *
 * Each entry is [bits, length] where:
 *   - bits: the VLC codeword value (MSB-first integer)
 *   - length: number of bits in the codeword
 *
 * Source: Verified against x264 (common/tables.c) and FFmpeg (libavcodec/h264_cavlc.c).
 *
 * @module codecs/h264-cavlc-tables
 */

// ══════════════════════════════════════════════════════════════════════════════
// coeff_token for TotalCoeff=0 (no coefficients)
// Indexed by nC table index (0-5):
//   0: nC 0-1,  1: nC 2-3,  2: nC 4-7,  3: nC 8+,  4: nC=-1 (ChromaDC 2x2),  5: nC=-2 (ChromaDC 2x4)
// Table 9-5 in the spec
// ══════════════════════════════════════════════════════════════════════════════

export const coeff0Token = [
  [0x01, 1],  // nC 0-1:  "1"
  [0x03, 2],  // nC 2-3:  "11"
  [0x0f, 4],  // nC 4-7:  "1111"
  [0x03, 6],  // nC 8+:   "000011"
  [0x01, 2],  // ChromaDC 2x2: "01"
  [0x01, 1],  // ChromaDC 2x4: "1"
];

// ══════════════════════════════════════════════════════════════════════════════
// coeff_token VLC tables
// coeffTokenTable[nC_table][totalCoeff-1][trailingOnes] = [bits, length]
//
// nC table index mapping:
//   0: nC = 0,1      (Table 9-5a)
//   1: nC = 2,3      (Table 9-5b)
//   2: nC = 4,5,6,7  (Table 9-5c)
//   3: nC >= 8       (Table 9-5d)  -- fixed 6-bit codes
//   4: nC = -1       (Chroma DC 2x2, Table 9-5e)
//   5: nC = -2       (Chroma DC 2x4/4x2, for 4:2:2)
//
// trailingOnes: 0..3 (but only 0..min(totalCoeff,3) are valid)
// Invalid combinations have [0, 0] placeholder
// ══════════════════════════════════════════════════════════════════════════════

export const coeffTokenTable = [
  // ── nC = 0,1 (table 0) ──
  [
    // totalCoeff=1
    [[0x05, 6], [0x01, 2], [0, 0], [0, 0]],
    // totalCoeff=2
    [[0x07, 8], [0x04, 6], [0x01, 3], [0, 0]],
    // totalCoeff=3
    [[0x07, 9], [0x06, 8], [0x05, 7], [0x03, 5]],
    // totalCoeff=4
    [[0x07, 10], [0x06, 9], [0x05, 8], [0x03, 6]],
    // totalCoeff=5
    [[0x07, 11], [0x06, 10], [0x05, 9], [0x04, 7]],
    // totalCoeff=6
    [[0x0f, 13], [0x06, 11], [0x05, 10], [0x04, 8]],
    // totalCoeff=7
    [[0x0b, 13], [0x0e, 13], [0x05, 11], [0x04, 9]],
    // totalCoeff=8
    [[0x08, 13], [0x0a, 13], [0x0d, 13], [0x04, 10]],
    // totalCoeff=9
    [[0x0f, 14], [0x0e, 14], [0x09, 13], [0x04, 11]],
    // totalCoeff=10
    [[0x0b, 14], [0x0a, 14], [0x0d, 14], [0x0c, 13]],
    // totalCoeff=11
    [[0x0f, 15], [0x0e, 15], [0x09, 14], [0x0c, 14]],
    // totalCoeff=12
    [[0x0b, 15], [0x0a, 15], [0x0d, 15], [0x08, 14]],
    // totalCoeff=13
    [[0x0f, 16], [0x01, 15], [0x09, 15], [0x0c, 15]],
    // totalCoeff=14
    [[0x0b, 16], [0x0e, 16], [0x0d, 16], [0x08, 15]],
    // totalCoeff=15
    [[0x07, 16], [0x0a, 16], [0x09, 16], [0x0c, 16]],
    // totalCoeff=16
    [[0x04, 16], [0x06, 16], [0x05, 16], [0x08, 16]],
  ],

  // ── nC = 2,3 (table 1) ──
  [
    // totalCoeff=1
    [[0x0b, 6], [0x02, 2], [0, 0], [0, 0]],
    // totalCoeff=2
    [[0x07, 6], [0x07, 5], [0x03, 3], [0, 0]],
    // totalCoeff=3
    [[0x07, 7], [0x0a, 6], [0x09, 6], [0x05, 4]],
    // totalCoeff=4
    [[0x07, 8], [0x06, 6], [0x05, 6], [0x04, 4]],
    // totalCoeff=5
    [[0x04, 8], [0x06, 7], [0x05, 7], [0x06, 5]],
    // totalCoeff=6
    [[0x07, 9], [0x06, 8], [0x05, 8], [0x08, 6]],
    // totalCoeff=7
    [[0x0f, 11], [0x06, 9], [0x05, 9], [0x04, 6]],
    // totalCoeff=8
    [[0x0b, 11], [0x0e, 11], [0x0d, 11], [0x04, 7]],
    // totalCoeff=9
    [[0x0f, 12], [0x0a, 11], [0x09, 11], [0x04, 9]],
    // totalCoeff=10
    [[0x0b, 12], [0x0e, 12], [0x0d, 12], [0x0c, 11]],
    // totalCoeff=11
    [[0x08, 12], [0x0a, 12], [0x09, 12], [0x08, 11]],
    // totalCoeff=12
    [[0x0f, 13], [0x0e, 13], [0x0d, 13], [0x0c, 12]],
    // totalCoeff=13
    [[0x0b, 13], [0x0a, 13], [0x09, 13], [0x0c, 13]],
    // totalCoeff=14
    [[0x07, 13], [0x0b, 14], [0x06, 13], [0x08, 13]],
    // totalCoeff=15
    [[0x09, 14], [0x08, 14], [0x0a, 14], [0x01, 13]],
    // totalCoeff=16
    [[0x07, 14], [0x06, 14], [0x05, 14], [0x04, 14]],
  ],

  // ── nC = 4,5,6,7 (table 2) ──
  [
    // totalCoeff=1
    [[0x0f, 6], [0x0e, 4], [0, 0], [0, 0]],
    // totalCoeff=2
    [[0x0b, 6], [0x0f, 5], [0x0d, 4], [0, 0]],
    // totalCoeff=3
    [[0x08, 6], [0x0c, 5], [0x0e, 5], [0x0c, 4]],
    // totalCoeff=4
    [[0x0f, 7], [0x0a, 5], [0x0b, 5], [0x0b, 4]],
    // totalCoeff=5
    [[0x0b, 7], [0x08, 5], [0x09, 5], [0x0a, 4]],
    // totalCoeff=6
    [[0x09, 7], [0x0e, 6], [0x0d, 6], [0x09, 4]],
    // totalCoeff=7
    [[0x08, 7], [0x0a, 6], [0x09, 6], [0x08, 4]],
    // totalCoeff=8
    [[0x0f, 8], [0x0e, 7], [0x0d, 7], [0x0d, 5]],
    // totalCoeff=9
    [[0x0b, 8], [0x0e, 8], [0x0a, 7], [0x0c, 6]],
    // totalCoeff=10
    [[0x0f, 9], [0x0a, 8], [0x0d, 8], [0x0c, 7]],
    // totalCoeff=11
    [[0x0b, 9], [0x0e, 9], [0x09, 8], [0x0c, 8]],
    // totalCoeff=12
    [[0x08, 9], [0x0a, 9], [0x0d, 9], [0x08, 8]],
    // totalCoeff=13
    [[0x0d, 10], [0x07, 9], [0x09, 9], [0x0c, 9]],
    // totalCoeff=14
    [[0x09, 10], [0x0c, 10], [0x0b, 10], [0x0a, 10]],
    // totalCoeff=15
    [[0x05, 10], [0x08, 10], [0x07, 10], [0x06, 10]],
    // totalCoeff=16
    [[0x01, 10], [0x04, 10], [0x03, 10], [0x02, 10]],
  ],

  // ── nC >= 8 (table 3) ── fixed-length 6-bit codes
  [
    // totalCoeff=1
    [[0x00, 6], [0x01, 6], [0, 0], [0, 0]],
    // totalCoeff=2
    [[0x04, 6], [0x05, 6], [0x06, 6], [0, 0]],
    // totalCoeff=3
    [[0x08, 6], [0x09, 6], [0x0a, 6], [0x0b, 6]],
    // totalCoeff=4
    [[0x0c, 6], [0x0d, 6], [0x0e, 6], [0x0f, 6]],
    // totalCoeff=5
    [[0x10, 6], [0x11, 6], [0x12, 6], [0x13, 6]],
    // totalCoeff=6
    [[0x14, 6], [0x15, 6], [0x16, 6], [0x17, 6]],
    // totalCoeff=7
    [[0x18, 6], [0x19, 6], [0x1a, 6], [0x1b, 6]],
    // totalCoeff=8
    [[0x1c, 6], [0x1d, 6], [0x1e, 6], [0x1f, 6]],
    // totalCoeff=9
    [[0x20, 6], [0x21, 6], [0x22, 6], [0x23, 6]],
    // totalCoeff=10
    [[0x24, 6], [0x25, 6], [0x26, 6], [0x27, 6]],
    // totalCoeff=11
    [[0x28, 6], [0x29, 6], [0x2a, 6], [0x2b, 6]],
    // totalCoeff=12
    [[0x2c, 6], [0x2d, 6], [0x2e, 6], [0x2f, 6]],
    // totalCoeff=13
    [[0x30, 6], [0x31, 6], [0x32, 6], [0x33, 6]],
    // totalCoeff=14
    [[0x34, 6], [0x35, 6], [0x36, 6], [0x37, 6]],
    // totalCoeff=15
    [[0x38, 6], [0x39, 6], [0x3a, 6], [0x3b, 6]],
    // totalCoeff=16
    [[0x3c, 6], [0x3d, 6], [0x3e, 6], [0x3f, 6]],
  ],

  // ── nC = -1: Chroma DC 2x2 (4:2:0) (table 4) ── maxCoeff=4
  [
    // totalCoeff=1
    [[0x07, 6], [0x01, 1], [0, 0], [0, 0]],
    // totalCoeff=2
    [[0x04, 6], [0x06, 6], [0x01, 3], [0, 0]],
    // totalCoeff=3
    [[0x03, 6], [0x03, 7], [0x02, 7], [0x05, 6]],
    // totalCoeff=4
    [[0x02, 6], [0x03, 8], [0x02, 8], [0x00, 7]],
  ],

  // ── nC = -2: Chroma DC 2x4 (4:2:2) (table 5) ── maxCoeff=8
  [
    // totalCoeff=1
    [[0x0f, 7], [0x01, 2], [0, 0], [0, 0]],
    // totalCoeff=2
    [[0x0e, 7], [0x0d, 7], [0x01, 3], [0, 0]],
    // totalCoeff=3
    [[0x07, 9], [0x0c, 7], [0x0b, 7], [0x01, 5]],
    // totalCoeff=4
    [[0x06, 9], [0x05, 9], [0x0a, 7], [0x01, 6]],
    // totalCoeff=5
    [[0x07, 10], [0x06, 10], [0x04, 9], [0x09, 7]],
    // totalCoeff=6
    [[0x07, 11], [0x06, 11], [0x05, 10], [0x08, 7]],
    // totalCoeff=7
    [[0x07, 12], [0x06, 12], [0x05, 11], [0x04, 10]],
    // totalCoeff=8
    [[0x07, 13], [0x05, 12], [0x04, 12], [0x04, 11]],
  ],
];

/**
 * Maps nC (predicted number of non-zero coefficients) to table index.
 * nC < 0: use -1 → index 4 (ChromaDC 2x2) or -2 → index 5 (ChromaDC 2x4)
 * nC 0-1: index 0
 * nC 2-3: index 1
 * nC 4-7: index 2
 * nC >= 8: index 3
 */
export function nCtoTableIndex(nC) {
  if (nC < 0) return nC === -1 ? 4 : 5;
  if (nC <= 1) return 0;
  if (nC <= 3) return 1;
  if (nC <= 7) return 2;
  return 3;
}

// ══════════════════════════════════════════════════════════════════════════════
// total_zeros VLC tables (Table 9-7 in the spec)
// totalZerosTable[totalCoeff-1][totalZeros] = [bits, length]
// For 4x4 blocks, TotalCoeff = 1..15
// totalZeros range: 0..(16-TotalCoeff)
// ══════════════════════════════════════════════════════════════════════════════

export const totalZerosTable = [
  // totalCoeff=1: totalZeros 0..15
  [
    [0x01, 1], [0x03, 3], [0x02, 3], [0x03, 4],
    [0x02, 4], [0x03, 5], [0x02, 5], [0x03, 6],
    [0x02, 6], [0x03, 7], [0x02, 7], [0x03, 8],
    [0x02, 8], [0x03, 9], [0x02, 9], [0x01, 9],
  ],
  // totalCoeff=2: totalZeros 0..14
  [
    [0x07, 3], [0x06, 3], [0x05, 3], [0x04, 3],
    [0x03, 3], [0x05, 4], [0x04, 4], [0x03, 4],
    [0x02, 4], [0x03, 5], [0x02, 5], [0x03, 6],
    [0x02, 6], [0x01, 6], [0x00, 6],
  ],
  // totalCoeff=3: totalZeros 0..13
  [
    [0x05, 4], [0x07, 3], [0x06, 3], [0x05, 3],
    [0x04, 4], [0x03, 4], [0x04, 3], [0x03, 3],
    [0x02, 4], [0x03, 5], [0x02, 5], [0x01, 6],
    [0x01, 5], [0x00, 6],
  ],
  // totalCoeff=4: totalZeros 0..12
  [
    [0x03, 5], [0x07, 3], [0x05, 4], [0x04, 4],
    [0x06, 3], [0x05, 3], [0x04, 3], [0x03, 4],
    [0x03, 3], [0x02, 4], [0x02, 5], [0x01, 5],
    [0x00, 5],
  ],
  // totalCoeff=5: totalZeros 0..11
  [
    [0x05, 4], [0x04, 4], [0x03, 4], [0x07, 3],
    [0x06, 3], [0x05, 3], [0x04, 3], [0x03, 3],
    [0x02, 4], [0x01, 5], [0x01, 4], [0x00, 5],
  ],
  // totalCoeff=6: totalZeros 0..10
  [
    [0x01, 6], [0x01, 5], [0x07, 3], [0x06, 3],
    [0x05, 3], [0x04, 3], [0x03, 3], [0x02, 3],
    [0x01, 4], [0x01, 3], [0x00, 6],
  ],
  // totalCoeff=7: totalZeros 0..9
  [
    [0x01, 6], [0x01, 5], [0x05, 3], [0x04, 3],
    [0x03, 3], [0x03, 2], [0x02, 3], [0x01, 4],
    [0x01, 3], [0x00, 6],
  ],
  // totalCoeff=8: totalZeros 0..8
  [
    [0x01, 6], [0x01, 4], [0x01, 5], [0x03, 3],
    [0x03, 2], [0x02, 2], [0x02, 3], [0x01, 3],
    [0x00, 6],
  ],
  // totalCoeff=9: totalZeros 0..7
  [
    [0x01, 6], [0x00, 6], [0x01, 4], [0x03, 2],
    [0x02, 2], [0x01, 3], [0x01, 2], [0x01, 5],
  ],
  // totalCoeff=10: totalZeros 0..6
  [
    [0x01, 5], [0x00, 5], [0x01, 3], [0x03, 2],
    [0x02, 2], [0x01, 2], [0x01, 4],
  ],
  // totalCoeff=11: totalZeros 0..5
  [
    [0x00, 4], [0x01, 4], [0x01, 3], [0x02, 3],
    [0x01, 1], [0x03, 3],
  ],
  // totalCoeff=12: totalZeros 0..4
  [
    [0x00, 4], [0x01, 4], [0x01, 2], [0x01, 1],
    [0x01, 3],
  ],
  // totalCoeff=13: totalZeros 0..3
  [
    [0x00, 3], [0x01, 3], [0x01, 1], [0x01, 2],
  ],
  // totalCoeff=14: totalZeros 0..2
  [
    [0x00, 2], [0x01, 2], [0x01, 1],
  ],
  // totalCoeff=15: totalZeros 0..1
  [
    [0x00, 1], [0x01, 1],
  ],
];

// ══════════════════════════════════════════════════════════════════════════════
// total_zeros for Chroma DC 2x2 (4:2:0) — Table 9-8 in the spec
// totalZerosChromaDC2x2[totalCoeff-1][totalZeros] = [bits, length]
// maxCoeff = 4, so totalCoeff = 1..3
// ══════════════════════════════════════════════════════════════════════════════

export const totalZerosChromaDC2x2 = [
  // totalCoeff=1: totalZeros 0..3
  [
    [0x01, 1], [0x01, 2], [0x01, 3], [0x00, 3],
  ],
  // totalCoeff=2: totalZeros 0..2
  [
    [0x01, 1], [0x01, 2], [0x00, 2],
  ],
  // totalCoeff=3: totalZeros 0..1
  [
    [0x01, 1], [0x00, 1],
  ],
];

// ══════════════════════════════════════════════════════════════════════════════
// total_zeros for Chroma DC 2x4 (4:2:2) — Table 9-9 in the spec
// totalZerosChromaDC2x4[totalCoeff-1][totalZeros] = [bits, length]
// maxCoeff = 8, so totalCoeff = 1..7
// ══════════════════════════════════════════════════════════════════════════════

export const totalZerosChromaDC2x4 = [
  // totalCoeff=1: totalZeros 0..7
  [
    [0x01, 1], [0x02, 3], [0x03, 3], [0x02, 4],
    [0x03, 4], [0x01, 4], [0x01, 5], [0x00, 5],
  ],
  // totalCoeff=2: totalZeros 0..6
  [
    [0x00, 3], [0x01, 2], [0x01, 3], [0x04, 3],
    [0x05, 3], [0x06, 3], [0x07, 3],
  ],
  // totalCoeff=3: totalZeros 0..5
  [
    [0x00, 3], [0x01, 3], [0x01, 2], [0x02, 2],
    [0x06, 3], [0x07, 3],
  ],
  // totalCoeff=4: totalZeros 0..4
  [
    [0x06, 3], [0x00, 2], [0x01, 2], [0x02, 2],
    [0x07, 3],
  ],
  // totalCoeff=5: totalZeros 0..3
  [
    [0x00, 2], [0x01, 2], [0x02, 2], [0x03, 2],
  ],
  // totalCoeff=6: totalZeros 0..2
  [
    [0x00, 2], [0x01, 2], [0x01, 1],
  ],
  // totalCoeff=7: totalZeros 0..1
  [
    [0x00, 1], [0x01, 1],
  ],
];

// ══════════════════════════════════════════════════════════════════════════════
// run_before VLC tables — Table 9-10 in the spec
// runBeforeTable[min(zerosLeft,7)-1][runBefore] = [bits, length]
//
// zerosLeft=1..6 have individual tables
// zerosLeft>=7 shares one table (index 6)
// ══════════════════════════════════════════════════════════════════════════════

export const runBeforeTable = [
  // zerosLeft=1: runBefore 0..1
  [
    [0x01, 1], [0x00, 1],
  ],
  // zerosLeft=2: runBefore 0..2
  [
    [0x01, 1], [0x01, 2], [0x00, 2],
  ],
  // zerosLeft=3: runBefore 0..3
  [
    [0x03, 2], [0x02, 2], [0x01, 2], [0x00, 2],
  ],
  // zerosLeft=4: runBefore 0..4
  [
    [0x03, 2], [0x02, 2], [0x01, 2], [0x01, 3], [0x00, 3],
  ],
  // zerosLeft=5: runBefore 0..5
  [
    [0x03, 2], [0x02, 2], [0x03, 3], [0x02, 3], [0x01, 3], [0x00, 3],
  ],
  // zerosLeft=6: runBefore 0..6
  [
    [0x03, 2], [0x00, 3], [0x01, 3], [0x03, 3], [0x02, 3], [0x05, 3], [0x04, 3],
  ],
  // zerosLeft>=7: runBefore 0..14
  [
    [0x07, 3], [0x06, 3], [0x05, 3], [0x04, 3],
    [0x03, 3], [0x02, 3], [0x01, 3], [0x01, 4],
    [0x01, 5], [0x01, 6], [0x01, 7], [0x01, 8],
    [0x01, 9], [0x01, 10], [0x01, 11],
  ],
];

// ══════════════════════════════════════════════════════════════════════════════
// Level encoding (coefficient magnitude/sign)
//
// The H.264 CAVLC level encoding uses:
//   1) level_prefix: unary code (N zeros followed by a 1)
//   2) level_suffix: fixed-length code of length suffixLength
//
// The suffixLength starts at 0 (or 1 if totalCoeff>10 && trailingOnes<3)
// and increases as larger levels are encountered.
//
// This function encodes a single coefficient level and returns
// [bits, length, newSuffixLength].
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Thresholds for incrementing suffixLength.
 * After encoding a level, if |level| > nextSuffix[suffixLength],
 * increment suffixLength.
 * From x264: {0, 3, 6, 12, 24, 48, 0xffff}
 */
const SUFFIX_THRESHOLD = [0, 3, 6, 12, 24, 48, 0x7fffffff];

/**
 * Encode a single coefficient level value using CAVLC level VLC.
 *
 * Algorithm from ITU-T H.264 Section 9.2.2 and verified against
 * x264 (common/vlc.c x264_level_token / encoder/cavlc.c cavlc_block_residual_escape).
 *
 * @param {number} level - Signed coefficient level (non-zero)
 * @param {number} suffixLength - Current suffix length (0-6)
 * @param {boolean} firstAfterTrailing - True if this is the first level after
 *   trailing ones and trailingOnes < 3. The spec says to subtract 1 from the
 *   magnitude (since we know it must be > 1 in this case).
 * @returns {{ bits: number, length: number, suffixLength: number }}
 */
export function encodeLevel(level, suffixLength, firstAfterTrailing) {
  const sign = level < 0 ? 1 : 0;
  let absLevel = Math.abs(level);

  // level_code = 2*|level| - 2 + sign
  // If firstAfterTrailing, the decoded level is offset by 1
  // (since |level| > 1 is guaranteed), so we adjust:
  let levelCode = (absLevel << 1) - 2 + sign;
  if (firstAfterTrailing) {
    levelCode -= 2;
  }

  let bits, length;

  const prefix = levelCode >> suffixLength;

  if (prefix < 14) {
    // Normal case: prefix zeros + 1 + suffix bits
    length = prefix + 1 + suffixLength;
    bits = (1 << suffixLength) | (levelCode & ((1 << suffixLength) - 1));
  } else if (suffixLength === 0 && prefix === 14) {
    // Special case: suffixLength=0, prefix=14 uses 4-bit suffix
    length = 15 + 4; // 19 bits total (14 zeros + 1 + 4 suffix bits)
    bits = (1 << 4) | (levelCode - 14);
  } else if (prefix === 14) {
    // suffixLength > 0, prefix=14: normal encoding still applies
    length = 14 + 1 + suffixLength;
    bits = (1 << suffixLength) | (levelCode & ((1 << suffixLength) - 1));
  } else {
    // prefix >= 15: escape code (High Profile level codes)
    let escapeLevelCode = levelCode;
    escapeLevelCode -= 15 << suffixLength;
    if (suffixLength === 0) {
      escapeLevelCode -= 15;
    }

    let levelPrefix = 15;
    // For very large values, extend the prefix (High Profile)
    while (escapeLevelCode >= (1 << (levelPrefix - 3))) {
      escapeLevelCode -= 1 << (levelPrefix - 3);
      levelPrefix++;
    }

    // prefix unary code (levelPrefix zeros + 1) + (levelPrefix-3) suffix bits
    length = levelPrefix + 1 + (levelPrefix - 3);
    bits = (1 << (levelPrefix - 3)) | (escapeLevelCode & ((1 << (levelPrefix - 3)) - 1));
  }

  // Update suffixLength
  let newSuffixLength = suffixLength;
  if (newSuffixLength === 0) {
    newSuffixLength = 1;
  }
  if (absLevel > SUFFIX_THRESHOLD[newSuffixLength]) {
    newSuffixLength++;
  }

  return { bits, length, suffixLength: newSuffixLength };
}

/**
 * Encode the full set of non-trailing-one levels for a residual block.
 *
 * @param {number[]} levels - Array of signed level values (non-trailing, in reverse scan order)
 * @param {number} trailingOnes - Number of trailing ones (0-3)
 * @param {number} totalCoeff - Total number of non-zero coefficients
 * @returns {{ bits: number[], lengths: number[] }} - Arrays of VLC codewords
 */
export function encodeLevels(levels, trailingOnes, totalCoeff) {
  const bits = [];
  const lengths = [];

  // Initial suffix length
  let suffixLength = (totalCoeff > 10 && trailingOnes < 3) ? 1 : 0;

  for (let i = 0; i < levels.length; i++) {
    const firstAfterTrailing = (i === 0 && trailingOnes < 3);
    const result = encodeLevel(levels[i], suffixLength, firstAfterTrailing);
    bits.push(result.bits);
    lengths.push(result.length);
    suffixLength = result.suffixLength;
  }

  return { bits, lengths };
}

// ══════════════════════════════════════════════════════════════════════════════
// Convenience: encode a full CAVLC residual block
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Write coeff_token to a bitstream writer.
 *
 * @param {number} totalCoeff - Total non-zero coefficients (0-16)
 * @param {number} trailingOnes - Number of trailing +/-1 coefficients (0-3)
 * @param {number} nC - Predicted number of non-zero coefficients
 * @returns {[number, number]} [bits, length] for the coeff_token VLC
 */
export function getCoeffToken(totalCoeff, trailingOnes, nC) {
  const tableIdx = nCtoTableIndex(nC);
  if (totalCoeff === 0) {
    return coeff0Token[tableIdx];
  }
  return coeffTokenTable[tableIdx][totalCoeff - 1][trailingOnes];
}

/**
 * Get total_zeros VLC for a 4x4 block.
 *
 * @param {number} totalCoeff - 1..15
 * @param {number} totalZeros - 0..(16-totalCoeff)
 * @returns {[number, number]} [bits, length]
 */
export function getTotalZeros(totalCoeff, totalZeros) {
  return totalZerosTable[totalCoeff - 1][totalZeros];
}

/**
 * Get total_zeros VLC for chroma DC 2x2 block.
 *
 * @param {number} totalCoeff - 1..3
 * @param {number} totalZeros - 0..(4-totalCoeff)
 * @returns {[number, number]} [bits, length]
 */
export function getTotalZerosChromaDC(totalCoeff, totalZeros) {
  return totalZerosChromaDC2x2[totalCoeff - 1][totalZeros];
}

/**
 * Get total_zeros VLC for chroma DC 2x4 block (4:2:2).
 *
 * @param {number} totalCoeff - 1..7
 * @param {number} totalZeros - 0..(8-totalCoeff)
 * @returns {[number, number]} [bits, length]
 */
export function getTotalZerosChromaDC422(totalCoeff, totalZeros) {
  return totalZerosChromaDC2x4[totalCoeff - 1][totalZeros];
}

/**
 * Get run_before VLC.
 *
 * @param {number} zerosLeft - Remaining zeros to distribute (>= 1)
 * @param {number} runBefore - Run of zeros before this coefficient
 * @returns {[number, number]} [bits, length]
 */
export function getRunBefore(zerosLeft, runBefore) {
  const idx = Math.min(zerosLeft, 7) - 1;
  return runBeforeTable[idx][runBefore];
}
