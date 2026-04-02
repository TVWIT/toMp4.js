/**
 * H.264 CABAC Decoder
 *
 * Context-Adaptive Binary Arithmetic Coding decoder for H.264/AVC.
 * Implements the decoding engine, context model management, and
 * binarization of syntax elements.
 *
 * Reference: ITU-T H.264, Section 9.3
 *
 * @module codecs/h264-cabac
 */

import { rangeTabLPS, transIdxLPS, transIdxMPS } from './h264-tables.js';

// ══════════════════════════════════════════════════════════
// Bitstream Reader (Exp-Golomb + raw bits)
// ══════════════════════════════════════════════════════════

export class BitstreamReader {
  /**
   * @param {Uint8Array} data - NAL unit data (RBSP, after emulation prevention removal)
   * @param {number} [startBit=0] - Starting bit position
   */
  constructor(data, startBit = 0) {
    this.data = data;
    this.bitPos = startBit;
  }

  get bitsLeft() {
    return this.data.length * 8 - this.bitPos;
  }

  readBit() {
    if (this.bitPos >= this.data.length * 8) return 0;
    const byteIdx = this.bitPos >> 3;
    const bitIdx = 7 - (this.bitPos & 7);
    this.bitPos++;
    return (this.data[byteIdx] >> bitIdx) & 1;
  }

  readBits(n) {
    let val = 0;
    for (let i = 0; i < n; i++) {
      val = (val << 1) | this.readBit();
    }
    return val;
  }

  /** Unsigned Exp-Golomb */
  readUE() {
    let zeros = 0;
    while (this.readBit() === 0 && zeros < 32) zeros++;
    if (zeros === 0) return 0;
    return (1 << zeros) - 1 + this.readBits(zeros);
  }

  /** Signed Exp-Golomb */
  readSE() {
    const val = this.readUE();
    return (val & 1) ? (val + 1) >> 1 : -(val >> 1);
  }

  /** Truncated Exp-Golomb (for CABAC init) */
  readTE(max) {
    if (max > 1) return this.readUE();
    return 1 - this.readBit();
  }

  /** Align to byte boundary */
  alignByte() {
    this.bitPos = ((this.bitPos + 7) >> 3) << 3;
  }

  /** Read raw bytes (after byte alignment) */
  readBytes(n) {
    this.alignByte();
    const start = this.bitPos >> 3;
    const result = this.data.slice(start, start + n);
    this.bitPos += n * 8;
    return result;
  }

  /** Check if more RBSP data remains */
  moreRbspData() {
    if (this.bitsLeft <= 0) return false;
    // Look for RBSP stop bit (1 followed by zero padding)
    const saved = this.bitPos;
    let lastOneBit = -1;
    for (let i = this.bitPos; i < this.data.length * 8; i++) {
      const byteIdx = i >> 3;
      const bitIdx = 7 - (i & 7);
      if ((this.data[byteIdx] >> bitIdx) & 1) lastOneBit = i;
    }
    return lastOneBit > this.bitPos;
  }
}

// ══════════════════════════════════════════════════════════
// Remove Emulation Prevention Bytes
// ══════════════════════════════════════════════════════════

/**
 * Convert NAL unit from RBSP to SODB by removing emulation prevention bytes.
 * 0x00 0x00 0x03 → 0x00 0x00
 */
export function removeEmulationPrevention(nalData) {
  const result = [];
  for (let i = 0; i < nalData.length; i++) {
    if (i + 2 < nalData.length &&
        nalData[i] === 0x00 && nalData[i + 1] === 0x00 && nalData[i + 2] === 0x03) {
      result.push(0x00, 0x00);
      i += 2; // skip the 0x03
    } else {
      result.push(nalData[i]);
    }
  }
  return new Uint8Array(result);
}

// ══════════════════════════════════════════════════════════
// CABAC Context
// ══════════════════════════════════════════════════════════

class CabacContext {
  constructor() {
    this.pStateIdx = 0;
    this.valMPS = 0;
  }

  init(sliceQPy, m, n) {
    const preCtxState = Math.max(1, Math.min(126, ((m * sliceQPy) >> 4) + n));
    if (preCtxState <= 63) {
      this.pStateIdx = 63 - preCtxState;
      this.valMPS = 0;
    } else {
      this.pStateIdx = preCtxState - 64;
      this.valMPS = 1;
    }
  }
}

// ══════════════════════════════════════════════════════════
// CABAC Decoder Engine
// ══════════════════════════════════════════════════════════

export class CabacDecoder {
  /**
   * Spec-compliant CABAC decoder (ITU-T H.264 Section 9.3).
   * Uses separate pStateIdx/valMPS per context.
   *
   * @param {Uint8Array} data - RBSP data (emulation prevention removed)
   * @param {number} startBit - Bit position where CABAC data begins
   */
  constructor(data, startBit) {
    this.data = data;
    // Byte-align the start position (CABAC starts at byte boundary after slice header)
    this.bytePos = (startBit + 7) >> 3;
    this.bitInByte = 0;

    // Arithmetic decoder state
    this.codIRange = 510;
    this.codIOffset = 0;

    // Context models
    this.contexts = [];
    for (let i = 0; i < 1024; i++) {
      this.contexts.push(new CabacContext());
    }

    // Read 9 bits to initialize codIOffset
    for (let i = 0; i < 9; i++) {
      this.codIOffset = (this.codIOffset << 1) | this._readBit();
    }
  }

  _readBit() {
    if (this.bytePos >= this.data.length) return 0;
    const bit = (this.data[this.bytePos] >> (7 - this.bitInByte)) & 1;
    this.bitInByte++;
    if (this.bitInByte === 8) {
      this.bitInByte = 0;
      this.bytePos++;
    }
    return bit;
  }

  /**
   * Initialize context models for a slice.
   */
  initContexts(sliceType, sliceQPy, cabacInitIdc, initTable) {
    for (let i = 0; i < initTable.length; i++) {
      const [m, n] = initTable[i];
      this.contexts[i].init(sliceQPy, m, n);
    }
  }

  /**
   * Decode a single bin using a context model (Section 9.3.3.2.1).
   */
  decodeBin(ctxIdx) {
    const ctx = this.contexts[ctxIdx];
    const qCodIRangeIdx = (this.codIRange >> 6) & 3;
    const codIRangeLPS = rangeTabLPS[ctx.pStateIdx][qCodIRangeIdx];
    this.codIRange -= codIRangeLPS;

    let binVal;
    if (this.codIOffset >= this.codIRange) {
      // LPS path
      binVal = 1 - ctx.valMPS;
      this.codIOffset -= this.codIRange;
      this.codIRange = codIRangeLPS;
      if (ctx.pStateIdx === 0) ctx.valMPS = 1 - ctx.valMPS;
      ctx.pStateIdx = transIdxLPS[ctx.pStateIdx];
    } else {
      // MPS path
      binVal = ctx.valMPS;
      ctx.pStateIdx = transIdxMPS[ctx.pStateIdx];
    }

    this._renorm();
    return binVal;
  }

  /**
   * Decode a bin in bypass mode (Section 9.3.3.2.3).
   */
  decodeBypass() {
    this.codIOffset = (this.codIOffset << 1) | this._readBit();
    if (this.codIOffset >= this.codIRange) {
      this.codIOffset -= this.codIRange;
      return 1;
    }
    return 0;
  }

  /**
   * Decode the terminate bin (Section 9.3.3.2.4).
   */
  decodeTerminate() {
    this.codIRange -= 2;
    if (this.codIOffset >= this.codIRange) {
      return 1; // end of slice
    }
    this._renorm();
    return 0;
  }

  /**
   * Renormalization (Section 9.3.3.2.2).
   */
  _renorm() {
    while (this.codIRange < 256) {
      this.codIRange <<= 1;
      this.codIOffset = (this.codIOffset << 1) | this._readBit();
    }
  }

  // ── High-level syntax element decoding ────────────────

  /**
   * Decode an unsigned value using truncated unary + exp-golomb binarization.
   * Used for mb_type, sub_mb_type, etc.
   */
  decodeUnary(ctxOffset, maxVal, ctxIncFn) {
    let val = 0;
    while (val < maxVal) {
      const ctxInc = ctxIncFn ? ctxIncFn(val) : Math.min(val, 1);
      const bin = this.decodeBin(ctxOffset + ctxInc);
      if (bin === 0) break;
      val++;
    }
    return val;
  }

  /**
   * Decode a signed value using unary/exp-golomb + sign bypass bin.
   */
  decodeSigned(ctxOffset, maxVal, ctxIncFn) {
    const absVal = this.decodeUnary(ctxOffset, maxVal, ctxIncFn);
    if (absVal === 0) return 0;
    const sign = this.decodeBypass();
    return sign ? -absVal : absVal;
  }

  /**
   * Decode a bypass-coded unsigned integer of n bits.
   */
  decodeBypassBits(n) {
    let val = 0;
    for (let i = 0; i < n; i++) {
      val = (val << 1) | this.decodeBypass();
    }
    return val;
  }

  /**
   * Decode an unsigned Exp-Golomb coded value (UEG) in CABAC.
   * Used for mvd, residual levels, etc.
   * prefix is unary coded, suffix is bypass Exp-Golomb.
   */
  decodeUEG(ctxOffset, maxPrefix, ctxIncFn) {
    // Prefix: unary coded with contexts
    let prefix = 0;
    while (prefix < maxPrefix) {
      const ctxInc = ctxIncFn ? ctxIncFn(prefix) : Math.min(prefix, maxPrefix - 1);
      const bin = this.decodeBin(ctxOffset + ctxInc);
      if (bin === 0) break;
      prefix++;
    }

    if (prefix < maxPrefix) return prefix;

    // Suffix: bypass Exp-Golomb (k=0)
    let k = 0;
    while (this.decodeBypass() === 1) k++;
    let suffix = 0;
    for (let i = 0; i < k; i++) {
      suffix = (suffix << 1) | this.decodeBypass();
    }
    return prefix + (1 << k) - 1 + suffix;
  }
}
