/**
 * H.264 Constant Tables
 *
 * Lookup tables from the H.264/AVC specification (ITU-T H.264).
 * Used by both the decoder and encoder.
 *
 * @module codecs/h264-tables
 */

// ══════════════════════════════════════════════════════════
// CABAC Range Table (Table 9-48)
// rangeTabLPS[pStateIdx][qCodIRangeIdx]
// ══════════════════════════════════════════════════════════

export const rangeTabLPS = [
  [128,176,208,240],[128,167,197,227],[128,158,187,216],[123,150,178,205],
  [116,142,169,195],[111,135,160,185],[105,128,152,175],[100,122,144,166],
  [ 95,116,137,158],[ 90,110,130,150],[ 85,104,123,142],[ 81, 99,117,135],
  [ 77, 94,111,128],[ 73, 89,105,122],[ 69, 85,100,116],[ 66, 80, 95,110],
  [ 62, 76, 90,104],[ 59, 72, 86, 99],[ 56, 69, 81, 94],[ 53, 65, 77, 89],
  [ 51, 62, 73, 85],[ 48, 59, 69, 80],[ 46, 56, 66, 76],[ 43, 53, 63, 72],
  [ 41, 50, 59, 69],[ 39, 48, 56, 65],[ 37, 45, 54, 62],[ 35, 43, 51, 59],
  [ 33, 41, 48, 56],[ 32, 39, 46, 53],[ 30, 37, 43, 50],[ 29, 35, 41, 48],
  [ 27, 33, 39, 45],[ 26, 31, 37, 43],[ 24, 30, 35, 41],[ 23, 28, 33, 39],
  [ 22, 27, 32, 37],[ 21, 26, 30, 35],[ 20, 24, 29, 33],[ 19, 23, 27, 31],
  [ 18, 22, 26, 30],[ 17, 21, 25, 28],[ 16, 20, 23, 27],[ 15, 19, 22, 25],
  [ 14, 18, 21, 24],[ 14, 17, 20, 23],[ 13, 16, 19, 22],[ 12, 15, 18, 21],
  [ 12, 14, 17, 20],[ 11, 14, 16, 19],[ 11, 13, 15, 18],[ 10, 12, 15, 17],
  [ 10, 12, 14, 16],[  9, 11, 13, 15],[  9, 11, 12, 14],[  8, 10, 12, 14],
  [  8,  9, 11, 13],[  7,  9, 11, 12],[  7,  9, 10, 12],[  7,  8, 10, 11],
  [  6,  8,  9, 11],[  6,  7,  9, 10],[  6,  7,  8,  9],[  2,  2,  2,  2],
];

// ══════════════════════════════════════════════════════════
// CABAC State Transition Tables (Table 9-49, 9-50)
// Original tables (pStateIdx only, 64 entries each)
// ══════════════════════════════════════════════════════════

export const transIdxLPS = [
   0, 0, 1, 2, 2, 4, 4, 5, 6, 7, 8, 9, 9,11,11,12,
  13,13,15,15,16,16,18,18,19,19,21,21,22,22,23,24,
  24,25,26,26,27,27,28,29,29,30,30,30,31,32,32,33,
  33,33,34,34,35,35,35,36,36,36,37,37,37,38,38,63,
];

export const transIdxMPS = [
   1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,15,16,
  17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
  33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,
  49,50,51,52,53,54,55,56,57,58,59,60,61,62,62,63,
];

// ══════════════════════════════════════════════════════════
// CABAC Context Initialization Values (Table 9-12 to 9-23)
// Each entry is [m, n] where initValue = m * SliceQPy + n
// Contexts 0-10: mb_type, sub_mb_type, etc.
// ══════════════════════════════════════════════════════════

// I-slice context init values (cabac_init_idc not used for I-slices)
// Format: array of [m, n] pairs, indexed by ctxIdx
export const cabacInitI = [
  // 0-10: mb_type SI
  [20,-15],[2,54],[3,74],[20,-15],[2,54],[3,74],[-28,127],[-23,104],[-6,53],[-1,54],[7,51],
  // 11-23: mb_type I
  [23,33],[23,2],[21,0],
  // We need ~460 contexts. The full table is very large.
  // For practical purposes, we'll initialize from the spec tables at runtime.
];

// P/B-slice context init values depend on cabac_init_idc (0, 1, or 2)
// These are used for the majority of syntax elements in P/B slices.
// The full tables are in the H.264 spec Annex, Tables 9-12 through 9-23.

// ══════════════════════════════════════════════════════════
// Inverse Zigzag Scan (4x4)
// Maps coefficient index → [row, col] in the 4x4 block
// ══════════════════════════════════════════════════════════

export const scanZigzag4x4 = [
  [0,0],[0,1],[1,0],[2,0],[1,1],[0,2],[0,3],[1,2],
  [2,1],[3,0],[3,1],[2,2],[1,3],[2,3],[3,2],[3,3],
];

// Flat index version: position[i] = row * 4 + col
export const scanOrder4x4 = scanZigzag4x4.map(([r,c]) => r * 4 + c);

// ══════════════════════════════════════════════════════════
// Inverse Zigzag Scan (8x8)
// ══════════════════════════════════════════════════════════

export const scanZigzag8x8 = [
  [0,0],[0,1],[1,0],[2,0],[1,1],[0,2],[0,3],[1,2],
  [2,1],[3,0],[4,0],[3,1],[2,2],[1,3],[0,4],[0,5],
  [1,4],[2,3],[3,2],[4,1],[5,0],[6,0],[5,1],[4,2],
  [3,3],[2,4],[1,5],[0,6],[0,7],[1,6],[2,5],[3,4],
  [4,3],[5,2],[6,1],[7,0],[7,1],[6,2],[5,3],[4,4],
  [3,5],[2,6],[1,7],[2,7],[3,6],[4,5],[5,4],[6,3],
  [7,2],[7,3],[6,4],[5,5],[4,6],[3,7],[4,7],[5,6],
  [6,5],[7,4],[7,5],[6,6],[5,7],[6,7],[7,6],[7,7],
];

export const scanOrder8x8 = scanZigzag8x8.map(([r,c]) => r * 8 + c);

// ══════════════════════════════════════════════════════════
// Quantization
// ══════════════════════════════════════════════════════════

// LevelScale for 4x4 inverse quantization (Table 8-13)
// levelScale[qp%6][i][j]
export const levelScale4x4 = [
  [10,13,10,13,13,16,13,16,10,13,10,13,13,16,13,16],
  [11,14,11,14,14,18,14,18,11,14,11,14,14,18,14,18],
  [13,16,13,16,16,20,16,20,13,16,13,16,16,20,16,20],
  [14,18,14,18,18,23,18,23,14,18,14,18,18,23,18,23],
  [16,20,16,20,20,25,20,25,16,20,16,20,20,25,20,25],
  [18,23,18,23,23,29,23,29,18,23,18,23,23,29,23,29],
];

// Quantization step sizes for encoder (forward quantization)
// MF[qp%6] values for 4x4 blocks
export const quantMF4x4 = [
  [13107,8066,13107,8066,8066,5243,8066,5243,13107,8066,13107,8066,8066,5243,8066,5243],
  [11916,7490,11916,7490,7490,4660,7490,4660,11916,7490,11916,7490,7490,4660,7490,4660],
  [10082,6554,10082,6554,6554,4194,6554,4194,10082,6554,10082,6554,6554,4194,6554,4194],
  [ 9362,5825, 9362,5825,5825,3647,5825,3647, 9362,5825, 9362,5825,5825,3647,5825,3647],
  [ 8192,5243, 8192,5243,5243,3355,5243,3355, 8192,5243, 8192,5243,5243,3355,5243,3355],
  [ 7282,4559, 7282,4559,4559,2893,4559,2893, 7282,4559, 7282,4559,4559,2893,4559,2893],
];

// ══════════════════════════════════════════════════════════
// Intra Prediction Modes
// ══════════════════════════════════════════════════════════

export const INTRA_4x4_V    = 0; // Vertical
export const INTRA_4x4_H    = 1; // Horizontal
export const INTRA_4x4_DC   = 2; // DC
export const INTRA_4x4_DDL  = 3; // Diagonal Down-Left
export const INTRA_4x4_DDR  = 4; // Diagonal Down-Right
export const INTRA_4x4_VR   = 5; // Vertical-Right
export const INTRA_4x4_HD   = 6; // Horizontal-Down
export const INTRA_4x4_VL   = 7; // Vertical-Left
export const INTRA_4x4_HU   = 8; // Horizontal-Up

export const INTRA_16x16_V     = 0; // Vertical
export const INTRA_16x16_H     = 1; // Horizontal
export const INTRA_16x16_DC    = 2; // DC
export const INTRA_16x16_PLANE = 3; // Plane

// ══════════════════════════════════════════════════════════
// Sub-pixel interpolation filter (6-tap)
// For half-pel motion compensation
// ══════════════════════════════════════════════════════════

export const SUBPEL_FILTER_TAPS = [1, -5, 20, 20, -5, 1];

// ══════════════════════════════════════════════════════════
// Macroblock type tables
// ══════════════════════════════════════════════════════════

// I-slice macroblock types (Table 7-11)
export const MB_TYPE_I_NxN = 0;   // Intra_4x4 or Intra_8x8
export const MB_TYPE_I_16x16_BASE = 1; // Intra_16x16 (types 1-24)
export const MB_TYPE_I_PCM = 25;

// P-slice macroblock types (Table 7-13)
export const MB_TYPE_P_L0_16x16 = 0;
export const MB_TYPE_P_L0_L0_16x8 = 1;
export const MB_TYPE_P_L0_L0_8x16 = 2;
export const MB_TYPE_P_8x8 = 3;
export const MB_TYPE_P_8x8ref0 = 4;

// Mapping from I_16x16 mb_type to prediction mode, CBP luma, CBP chroma
// mb_type 1-24: [intra16x16PredMode, CodedBlockPatternLuma, CodedBlockPatternChroma]
export const i16x16TypeMap = [
  // mb_type 1-4: CBP_luma=0, CBP_chroma=0, pred_mode 0-3
  [0,0,0],[1,0,0],[2,0,0],[3,0,0],
  // mb_type 5-8: CBP_luma=0, CBP_chroma=1
  [0,0,1],[1,0,1],[2,0,1],[3,0,1],
  // mb_type 9-12: CBP_luma=0, CBP_chroma=2
  [0,0,2],[1,0,2],[2,0,2],[3,0,2],
  // mb_type 13-16: CBP_luma=15, CBP_chroma=0
  [0,15,0],[1,15,0],[2,15,0],[3,15,0],
  // mb_type 17-20: CBP_luma=15, CBP_chroma=1
  [0,15,1],[1,15,1],[2,15,1],[3,15,1],
  // mb_type 21-24: CBP_luma=15, CBP_chroma=2
  [0,15,2],[1,15,2],[2,15,2],[3,15,2],
];

// ══════════════════════════════════════════════════════════
// CAVLC Tables (for encoder)
// ══════════════════════════════════════════════════════════

// coeff_token mapping: given (TotalCoeff, TrailingOnes, nC_range),
// returns the VLC codeword. Tables 9-5 through 9-8 in the spec.
// We'll generate these at init time to keep the file manageable.

// Total zeros tables (Table 9-7, 9-8)
// run_before tables (Table 9-10)
// These will be implemented in the encoder module.

// ══════════════════════════════════════════════════════════
// CBP mapping (Table 9-4)
// Maps codeNum to (CodedBlockPatternLuma, CodedBlockPatternChroma)
// For Inter and Intra macroblocks
// ══════════════════════════════════════════════════════════

export const cbpIntraMapping = [
  47, 31, 15,  0, 23, 27, 29, 30,  7, 11, 13, 14, 39, 43, 45, 46,
  16,  3,  5, 10, 12, 19, 21, 26, 28, 35, 37, 42, 44,  1,  2,  4,
   8, 17, 18, 20, 24,  6,  9, 22, 25, 32, 33, 34, 36, 40, 38, 41,
];

export const cbpInterMapping = [
   0, 16,  1,  2,  4,  8, 32,  3,  5, 10, 12, 15, 47,  7, 11, 13,
  14,  6,  9, 31, 35, 37, 42, 44, 33, 34, 36, 40, 39, 43, 45, 46,
  17, 18, 20, 24, 19, 21, 26, 28, 23, 27, 29, 30, 22, 25, 38, 41,
];
