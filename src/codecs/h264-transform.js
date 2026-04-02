/**
 * H.264 Integer Transforms and Quantization
 *
 * Forward and inverse 4x4/8x8 integer DCT transforms,
 * quantization, and dequantization as specified in H.264.
 *
 * Reference: ITU-T H.264, Section 8.5
 *
 * @module codecs/h264-transform
 */

import { levelScale4x4, quantMF4x4, scanOrder4x4 } from './h264-tables.js';

// ══════════════════════════════════════════════════════════
// 4x4 Inverse Integer Transform (Section 8.5.12.1)
// ══════════════════════════════════════════════════════════

/**
 * Inverse 4x4 integer DCT.
 * Input: 16-element array in raster order (after dequantization).
 * Output: 16-element residual array in raster order.
 */
export function inverseDCT4x4(coeffs) {
  const d = new Int32Array(16);
  const r = new Int32Array(16);

  // Copy input
  for (let i = 0; i < 16; i++) d[i] = coeffs[i];

  // Horizontal pass (rows)
  for (let i = 0; i < 4; i++) {
    const si = i * 4;
    const e0 = d[si + 0] + d[si + 2];
    const e1 = d[si + 0] - d[si + 2];
    const e2 = (d[si + 1] >> 1) - d[si + 3];
    const e3 = d[si + 1] + (d[si + 3] >> 1);

    r[si + 0] = e0 + e3;
    r[si + 1] = e1 + e2;
    r[si + 2] = e1 - e2;
    r[si + 3] = e0 - e3;
  }

  // Vertical pass (columns)
  const out = new Int32Array(16);
  for (let j = 0; j < 4; j++) {
    const e0 = r[j] + r[8 + j];
    const e1 = r[j] - r[8 + j];
    const e2 = (r[4 + j] >> 1) - r[12 + j];
    const e3 = r[4 + j] + (r[12 + j] >> 1);

    out[j]      = (e0 + e3 + 32) >> 6;
    out[4 + j]  = (e1 + e2 + 32) >> 6;
    out[8 + j]  = (e1 - e2 + 32) >> 6;
    out[12 + j] = (e0 - e3 + 32) >> 6;
  }

  return out;
}

// ══════════════════════════════════════════════════════════
// 4x4 Forward Integer Transform (Section 8.5 inverse)
// ══════════════════════════════════════════════════════════

/**
 * Forward 4x4 integer DCT (for encoder).
 * Input: 16-element residual array in raster order.
 * Output: 16-element coefficient array in raster order.
 */
export function forwardDCT4x4(residual) {
  const d = new Int32Array(16);
  const r = new Int32Array(16);

  for (let i = 0; i < 16; i++) d[i] = residual[i];

  // Horizontal pass (Cf * X)
  for (let i = 0; i < 4; i++) {
    const si = i * 4;
    const p0 = d[si + 0] + d[si + 3];
    const p1 = d[si + 1] + d[si + 2];
    const p2 = d[si + 1] - d[si + 2];
    const p3 = d[si + 0] - d[si + 3];

    r[si + 0] = p0 + p1;
    r[si + 1] = (p3 << 1) + p2;
    r[si + 2] = p0 - p1;
    r[si + 3] = p3 - (p2 << 1);
  }

  // Vertical pass (result * Cf^T)
  const out = new Int32Array(16);
  for (let j = 0; j < 4; j++) {
    const p0 = r[j] + r[12 + j];
    const p1 = r[4 + j] + r[8 + j];
    const p2 = r[4 + j] - r[8 + j];
    const p3 = r[j] - r[12 + j];

    out[j]      = p0 + p1;
    out[4 + j]  = (p3 << 1) + p2;
    out[8 + j]  = p0 - p1;
    out[12 + j] = p3 - (p2 << 1);
  }

  return out;
}

// ══════════════════════════════════════════════════════════
// 4x4 Hadamard Transform (for DC coefficients of Intra16x16)
// ══════════════════════════════════════════════════════════

/**
 * Forward 4x4 Hadamard transform for Intra16x16 luma DC coefficients.
 * Input: 16 DC values (one per 4x4 block in the 16x16 macroblock).
 * Output: 16 transformed values.
 */
export function forwardHadamard4x4(dc) {
  const t = new Int32Array(16);
  const out = new Int32Array(16);

  // Horizontal
  for (let i = 0; i < 4; i++) {
    const s = i * 4;
    const p0 = dc[s] + dc[s + 3];
    const p1 = dc[s + 1] + dc[s + 2];
    const p2 = dc[s + 1] - dc[s + 2];
    const p3 = dc[s] - dc[s + 3];
    t[s]     = p0 + p1;
    t[s + 1] = p3 + p2;
    t[s + 2] = p0 - p1;
    t[s + 3] = p3 - p2;
  }

  // Vertical
  for (let j = 0; j < 4; j++) {
    const p0 = t[j] + t[12 + j];
    const p1 = t[4 + j] + t[8 + j];
    const p2 = t[4 + j] - t[8 + j];
    const p3 = t[j] - t[12 + j];
    out[j]      = (p0 + p1) >> 1;
    out[4 + j]  = (p3 + p2) >> 1;
    out[8 + j]  = (p0 - p1) >> 1;
    out[12 + j] = (p3 - p2) >> 1;
  }

  return out;
}

/**
 * Inverse 4x4 Hadamard transform for Intra16x16 luma DC.
 */
export function inverseHadamard4x4(dc) {
  // Same as forward (Hadamard is its own inverse up to scaling)
  const t = new Int32Array(16);
  const out = new Int32Array(16);

  for (let i = 0; i < 4; i++) {
    const s = i * 4;
    const p0 = dc[s] + dc[s + 3];
    const p1 = dc[s + 1] + dc[s + 2];
    const p2 = dc[s + 1] - dc[s + 2];
    const p3 = dc[s] - dc[s + 3];
    t[s]     = p0 + p1;
    t[s + 1] = p3 + p2;
    t[s + 2] = p0 - p1;
    t[s + 3] = p3 - p2;
  }

  for (let j = 0; j < 4; j++) {
    const p0 = t[j] + t[12 + j];
    const p1 = t[4 + j] + t[8 + j];
    const p2 = t[4 + j] - t[8 + j];
    const p3 = t[j] - t[12 + j];
    out[j]      = p0 + p1;
    out[4 + j]  = p3 + p2;
    out[8 + j]  = p0 - p1;
    out[12 + j] = p3 - p2;
  }

  return out;
}

// ══════════════════════════════════════════════════════════
// 2x2 Hadamard Transform (for chroma DC)
// ══════════════════════════════════════════════════════════

export function forwardHadamard2x2(dc) {
  return new Int32Array([
    dc[0] + dc[1] + dc[2] + dc[3],
    dc[0] - dc[1] + dc[2] - dc[3],
    dc[0] + dc[1] - dc[2] - dc[3],
    dc[0] - dc[1] - dc[2] + dc[3],
  ]);
}

export function inverseHadamard2x2(dc) {
  // Same structure, no scaling needed for 2x2
  return forwardHadamard2x2(dc);
}

// ══════════════════════════════════════════════════════════
// Inverse Quantization (Dequantization)
// Section 8.5.12.1
// ══════════════════════════════════════════════════════════

/**
 * Dequantize a 4x4 block of transform coefficients.
 * @param {Int32Array} coeffs - 16 coefficients in scan order
 * @param {number} qp - Quantization parameter (0-51)
 * @param {boolean} isIntra - Whether the macroblock is intra
 * @returns {Int32Array} Dequantized coefficients in raster order
 */
export function dequantize4x4(coeffs, qp, isIntra) {
  const qpMod6 = qp % 6;
  const qpDiv6 = Math.floor(qp / 6);
  const scale = levelScale4x4[qpMod6];
  const out = new Int32Array(16);

  for (let i = 0; i < 16; i++) {
    const pos = scanOrder4x4[i];
    if (qpDiv6 >= 4) {
      out[pos] = (coeffs[i] * scale[i]) << (qpDiv6 - 4);
    } else {
      out[pos] = (coeffs[i] * scale[i] + (1 << (3 - qpDiv6))) >> (4 - qpDiv6);
    }
  }

  return out;
}

// ══════════════════════════════════════════════════════════
// Forward Quantization (for encoder)
// ══════════════════════════════════════════════════════════

/**
 * Quantize a 4x4 block of transform coefficients.
 * @param {Int32Array} coeffs - 16 coefficients in raster order
 * @param {number} qp - Quantization parameter (0-51)
 * @returns {Int32Array} Quantized coefficients in scan order
 */
export function quantize4x4(coeffs, qp) {
  const qpMod6 = qp % 6;
  const qpDiv6 = Math.floor(qp / 6);
  const mf = quantMF4x4[qpMod6];
  const qBits = 15 + qpDiv6;
  const offset = (1 << qBits) / 3; // intra offset = 1/3
  const out = new Int32Array(16);

  for (let i = 0; i < 16; i++) {
    const pos = scanOrder4x4[i];
    const sign = coeffs[pos] < 0 ? -1 : 1;
    const absVal = Math.abs(coeffs[pos]);
    out[i] = sign * ((absVal * mf[i] + offset) >> qBits);
  }

  return out;
}

// ══════════════════════════════════════════════════════════
// Clipping utility
// ══════════════════════════════════════════════════════════

export function clip(val, min, max) {
  return val < min ? min : val > max ? max : val;
}

export function clip255(val) {
  return val < 0 ? 0 : val > 255 ? 255 : val;
}
