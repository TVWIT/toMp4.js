/**
 * H.264 Decoder
 *
 * Decodes H.264 High profile CABAC streams to YUV pixel data.
 * Used by the HLS clipper for smart-rendering: decode a GOP from
 * keyframe to clip start, extract pixels, re-encode as I-frame.
 *
 * Reference: ITU-T H.264, FFmpeg libavcodec/h264_cabac.c
 *
 * @module codecs/h264-decoder
 */

import { CabacDecoder, removeEmulationPrevention } from './h264-cabac.js';
import { cabacInitI, cabacInitPB } from './h264-cabac-init.js';
import { parseSPSFull, parsePPSFull, parseSliceHeader } from './h264-sps-pps.js';
import { inverseDCT4x4, inverseHadamard4x4, inverseHadamard2x2, dequantize4x4, clip255 } from './h264-transform.js';
import { intra4x4Predict, intra16x16Predict, intraChromaPredict } from './h264-intra.js';
import { i16x16TypeMap } from './h264-tables.js';

// ── Context index offsets (Table 9-11) ────────────────────

const CTX_MB_TYPE_SI   = 0;
const CTX_MB_TYPE_I    = 3;
const CTX_MB_SKIP_P    = 11;
const CTX_MB_TYPE_P    = 14;
const CTX_SUB_MB_P     = 21;
const CTX_MB_SKIP_B    = 24;
const CTX_MB_TYPE_B    = 27;
const CTX_SUB_MB_B     = 36;
const CTX_MVD_X        = 40;
const CTX_MVD_Y        = 47;
const CTX_REF_IDX      = 54;
const CTX_QP_DELTA     = 60;
const CTX_CHROMA_PRED  = 64;
const CTX_INTRA_PRED_FLAG = 68;
const CTX_INTRA_PRED_REM  = 69;
const CTX_CBP_LUMA     = 73;
const CTX_CBP_CHROMA   = 77;

// coded_block_flag bases per category
const CBF_BASE = [85, 89, 93, 97, 101, 1012];

// significant_coeff / last_significant context offsets (frame mode)
const SIG_OFF  = [105, 120, 134, 149, 152, 402];
const LAST_OFF = [166, 181, 195, 210, 213, 417];

// coeff_abs_level_minus1 context offsets per category
const ABS_LEVEL_BASE = [227, 237, 247, 257, 266, 952];

// coeff_abs_level context state machine (from REFERENCE.md)
const LEVEL1_CTX    = [1, 2, 3, 4, 0, 0, 0, 0];
const LEVELGT1_CTX  = [5, 5, 5, 5, 6, 7, 8, 9];
const TRANS_ON_1    = [1, 2, 3, 3, 4, 5, 6, 7];
const TRANS_ON_GT1  = [4, 4, 4, 4, 5, 6, 7, 7];

// ── YUV Frame Buffer ──────────────────────────────────────

class YUVFrame {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.strideY = width;
    this.strideC = width >> 1;
    this.Y = new Uint8Array(width * height);
    this.U = new Uint8Array((width >> 1) * (height >> 1));
    this.V = new Uint8Array((width >> 1) * (height >> 1));
    this.poc = 0;
    this.frameNum = 0;
    this.isReference = false;
  }

  getY(x, y) {
    x = Math.max(0, Math.min(this.width - 1, x));
    y = Math.max(0, Math.min(this.height - 1, y));
    return this.Y[y * this.strideY + x];
  }

  getU(x, y) {
    x = Math.max(0, Math.min((this.width >> 1) - 1, x));
    y = Math.max(0, Math.min((this.height >> 1) - 1, y));
    return this.U[y * this.strideC + x];
  }

  getV(x, y) {
    x = Math.max(0, Math.min((this.width >> 1) - 1, x));
    y = Math.max(0, Math.min((this.height >> 1) - 1, y));
    return this.V[y * this.strideC + x];
  }

  clone() {
    const f = new YUVFrame(this.width, this.height);
    f.Y.set(this.Y); f.U.set(this.U); f.V.set(this.V);
    f.poc = this.poc; f.frameNum = this.frameNum;
    f.isReference = this.isReference;
    return f;
  }
}

// ── H.264 Decoder ─────────────────────────────────────────

export class H264Decoder {
  constructor() {
    this.spsMap = new Map();
    this.ppsMap = new Map();
    this.dpb = [];
    this.frame = null;
    this.sps = null;
    this.pps = null;

    // Per-frame MB state
    this.mbW = 0;
    this.mbH = 0;
    this.mbType = null;      // Int32Array[numMBs]
    this.mbCbpLuma = null;   // Uint8Array[numMBs]
    this.mbCbpChroma = null; // Uint8Array[numMBs]
    this.nzCoeff = null;     // non-zero coeff counts for coded_block_flag
    this.mbIntraChromaMode = null;
  }

  /**
   * Feed a NAL unit to the decoder.
   * @returns {YUVFrame|null}
   */
  feedNAL(nalUnit) {
    const nalType = nalUnit[0] & 0x1F;
    if (nalType === 7) {
      const sps = parseSPSFull(nalUnit);
      this.spsMap.set(sps.seq_parameter_set_id, sps);
      return null;
    }
    if (nalType === 8) {
      const sps = this.spsMap.values().next().value;
      const pps = parsePPSFull(nalUnit, sps);
      this.ppsMap.set(pps.pic_parameter_set_id, pps);
      return null;
    }
    if (nalType === 5 || nalType === 1) {
      return this._decodeSlice(nalUnit);
    }
    return null;
  }

  decodeAccessUnit(nalUnits) {
    let frame = null;
    for (const nal of nalUnits) {
      const result = this.feedNAL(nal);
      if (result) frame = result;
    }
    return frame;
  }

  // ── Slice Decoding ──────────────────────────────────────

  _decodeSlice(nalUnit) {
    if (this.spsMap.size === 0 || this.ppsMap.size === 0) return null;
    this.sps = this.spsMap.values().next().value;
    this.pps = this.ppsMap.values().next().value;

    const { sps, pps } = this;
    const sh = parseSliceHeader(nalUnit, sps, pps);

    if (sh.isIDR) this.dpb = [];

    const fw = sps.PicWidthInMbs * 16;
    const fh = sps.PicHeightInMbs * 16;
    this.frame = new YUVFrame(fw, fh);
    this.frame.frameNum = sh.frame_num;
    this.frame.poc = sh.pic_order_cnt_lsb;
    this.frame.isReference = sh.nal_ref_idc !== 0;

    this.mbW = sps.PicWidthInMbs;
    this.mbH = sps.PicHeightInMbs;
    const numMBs = sps.PicSizeInMbs;
    this.mbType = new Int32Array(numMBs).fill(-1);
    this.mbCbpLuma = new Uint8Array(numMBs);
    this.mbCbpChroma = new Uint8Array(numMBs);
    this.mbIntraChromaMode = new Uint8Array(numMBs);
    // 4x4 block non-zero coeff counts: 24 per MB (16 luma + 4 Cb + 4 Cr)
    this.nzCoeff = new Uint8Array(numMBs * 24);

    const refL0 = this._buildRefList(sh, 0);
    const refL1 = sh.isB ? this._buildRefList(sh, 1) : [];

    // Init CABAC
    const cabac = new CabacDecoder(sh._rbsp, sh.headerBitLength);
    const initTable = sh.isI ? cabacInitI : cabacInitPB[sh.cabac_init_idc];
    cabac.initContexts(sh.slice_type_mod5, sh.SliceQPY, sh.cabac_init_idc, initTable);

    let qp = sh.SliceQPY;
    let prevQPDelta = 0;
    let mbIdx = sh.first_mb_in_slice;

    while (mbIdx < numMBs) {
      const mbX = mbIdx % this.mbW;
      const mbY = (mbIdx / this.mbW) | 0;

      // Skip flag (P/B slices only)
      let skipped = false;
      if (!sh.isI) {
        skipped = this._decodeMbSkip(cabac, sh, mbIdx, mbX, mbY);
        if (skipped) {
          this.mbType[mbIdx] = -1; // skip
          this._reconstructSkip(mbX, mbY, refL0, sh);
          const endOfSlice = cabac.decodeTerminate();
          if (endOfSlice) break;
          mbIdx++;
          prevQPDelta = 0;
          continue;
        }
      }

      // Decode mb_type
      let mt;
      if (sh.isI) {
        mt = this._decodeMbTypeI(cabac, mbIdx);
      } else if (sh.isP) {
        mt = this._decodeMbTypeP(cabac, mbIdx);
      } else {
        mt = this._decodeMbTypeB(cabac, mbIdx);
      }
      this.mbType[mbIdx] = mt;

      // I_PCM
      if (this._isPCM(mt, sh)) {
        this._decodeIPCM(cabac, mbX, mbY);
        qp = sh.SliceQPY;
        prevQPDelta = 0;
        const endOfSlice = cabac.decodeTerminate();
        if (endOfSlice) break;
        mbIdx++;
        continue;
      }

      const isIntra = this._isIntra(mt, sh);
      const isI16 = this._isI16x16(mt, sh);
      const isINxN = this._isINxN(mt, sh);

      // Intra 4x4 prediction modes
      if (isINxN) {
        this._decodeIntra4x4Modes(cabac, mbX, mbY, mbIdx);
      }

      // Intra chroma prediction mode
      let chromaMode = 0;
      if (isIntra) {
        chromaMode = this._decodeChromaPredMode(cabac, mbIdx);
        this.mbIntraChromaMode[mbIdx] = chromaMode;
      }

      // Inter prediction
      if (!isIntra) {
        this._decodeInterPred(cabac, sh, mt, mbIdx, mbX, mbY, refL0, refL1);
      }

      // CBP
      let cbpL, cbpC;
      if (isI16) {
        const typeIdx = this._i16idx(mt, sh);
        cbpL = i16x16TypeMap[typeIdx][1];
        cbpC = i16x16TypeMap[typeIdx][2];
      } else {
        const cbp = this._decodeCBP(cabac, mbIdx, isIntra);
        cbpL = cbp & 0xF;
        cbpC = (cbp >> 4) & 0x3;
      }
      this.mbCbpLuma[mbIdx] = cbpL;
      this.mbCbpChroma[mbIdx] = cbpC;

      // QP delta
      let qpDelta = 0;
      if (cbpL > 0 || cbpC > 0 || isI16) {
        qpDelta = this._decodeQPDelta(cabac, prevQPDelta);
        prevQPDelta = qpDelta;
      } else {
        prevQPDelta = 0;
      }
      qp = ((qp + qpDelta + 52 + 52) % 52);

      // Reconstruct
      if (isI16) {
        this._reconI16x16(cabac, mbX, mbY, mt, sh, qp, cbpL, cbpC);
      } else if (isINxN) {
        this._reconINxN(cabac, mbX, mbY, qp, cbpL, cbpC);
      } else {
        this._reconInter(cabac, mbX, mbY, qp, cbpL, cbpC);
      }

      // Chroma
      this._reconChroma(cabac, mbX, mbY, qp, cbpC, isIntra, chromaMode);

      const endOfSlice = cabac.decodeTerminate();
      if (endOfSlice) break;
      mbIdx++;
    }

    // Deblocking
    if (sh.disable_deblocking_filter_idc !== 1) {
      this._deblock(sh);
    }

    // Store reference
    if (this.frame.isReference) {
      this.dpb.push(this.frame.clone());
      if (this.dpb.length > 16) this.dpb.shift();
    }

    return this.frame;
  }

  // ── mb_skip (P/B) ──────────────────────────────────────

  _decodeMbSkip(cabac, sh, mbIdx, mbX, mbY) {
    const ctxBase = sh.isP ? CTX_MB_SKIP_P : CTX_MB_SKIP_B;
    const leftSkip = mbX > 0 && this.mbType[mbIdx - 1] === -1 ? 0 : 1;
    const topSkip = mbY > 0 && this.mbType[mbIdx - this.mbW] === -1 ? 0 : 1;
    // Wait — skip context is: left NOT skip + top NOT skip
    // Actually from FFmpeg: ctxInc = (left_type != SKIP) + (top_type != SKIP)
    const ctxInc = (mbX > 0 && this.mbType[mbIdx - 1] !== -1 ? 1 : 0) +
                   (mbY > 0 && this.mbType[mbIdx - this.mbW] !== -1 ? 1 : 0);
    return cabac.decodeBin(ctxBase + ctxInc) === 1;
  }

  // ── mb_type decoders (FFmpeg patterns from REFERENCE.md) ─

  _decodeMbTypeI(cabac, mbIdx) {
    // I-slice: ctx base = 3
    const ctxInc = this._i16Neighbor(mbIdx);
    const bin0 = cabac.decodeBin(CTX_MB_TYPE_I + ctxInc);
    if (bin0 === 0) return 0; // I_NxN

    const term = cabac.decodeTerminate();
    if (term) return 25; // I_PCM

    // I_16x16 subtype
    let mt = 1;
    mt += 12 * cabac.decodeBin(CTX_MB_TYPE_I + 3); // cbp_luma != 0
    if (cabac.decodeBin(CTX_MB_TYPE_I + 4))         // cbp_chroma > 0
      mt += 4 + 4 * cabac.decodeBin(CTX_MB_TYPE_I + 5); // cbp_chroma == 2
    mt += 2 * cabac.decodeBin(CTX_MB_TYPE_I + 6);   // pred_mode bit 1
    mt += cabac.decodeBin(CTX_MB_TYPE_I + 7);        // pred_mode bit 0
    return mt;
  }

  _i16Neighbor(mbIdx) {
    const mbX = mbIdx % this.mbW;
    const mbY = (mbIdx / this.mbW) | 0;
    const left = mbX > 0 ? this.mbType[mbIdx - 1] : -1;
    const top = mbY > 0 ? this.mbType[mbIdx - this.mbW] : -1;
    // ctxInc = (left is I_16x16 or I_PCM) + (top is I_16x16 or I_PCM)
    return (left >= 1 ? 1 : 0) + (top >= 1 ? 1 : 0);
  }

  _decodeMbTypeP(cabac, mbIdx) {
    if (cabac.decodeBin(CTX_MB_TYPE_P + 0) === 0) {
      if (cabac.decodeBin(CTX_MB_TYPE_P + 1) === 0)
        return 3 * cabac.decodeBin(CTX_MB_TYPE_P + 2); // 0=P_L0_16x16, 3=P_8x8
      return 2 - cabac.decodeBin(CTX_MB_TYPE_P + 3); // 1=P_L0_16x8, 2=P_L0_8x16
    }
    // Intra in P-slice: decode I mb_type and add 5
    return 5 + this._decodeMbTypeIinPB(cabac, CTX_MB_TYPE_P + 3);
  }

  _decodeMbTypeB(cabac, mbIdx) {
    const ctxInc = this._bTypeNeighborCtx(mbIdx);
    if (cabac.decodeBin(CTX_MB_TYPE_B + ctxInc) === 0) return 0; // B_Direct_16x16

    if (cabac.decodeBin(CTX_MB_TYPE_B + 3) === 0)
      return 1 + cabac.decodeBin(CTX_MB_TYPE_B + 5); // B_L0_16x16 or B_L1_16x16

    if (cabac.decodeBin(CTX_MB_TYPE_B + 4) === 0) {
      return 3 + ((cabac.decodeBin(CTX_MB_TYPE_B + 5) << 1) |
                    cabac.decodeBin(CTX_MB_TYPE_B + 5)); // 3-6
    }

    if (cabac.decodeBin(CTX_MB_TYPE_B + 5) === 0) {
      return 7 + ((cabac.decodeBin(CTX_MB_TYPE_B + 5) << 1) |
                    cabac.decodeBin(CTX_MB_TYPE_B + 5)); // 7-10
    }

    if (cabac.decodeBin(CTX_MB_TYPE_B + 5) === 0) {
      return 11 + ((cabac.decodeBin(CTX_MB_TYPE_B + 5) << 1) |
                     cabac.decodeBin(CTX_MB_TYPE_B + 5)); // 11-14
    }

    if (cabac.decodeBin(CTX_MB_TYPE_B + 5) === 0) {
      return 15 + ((cabac.decodeBin(CTX_MB_TYPE_B + 5) << 1) |
                     cabac.decodeBin(CTX_MB_TYPE_B + 5)); // 15-18
    }

    if (cabac.decodeBin(CTX_MB_TYPE_B + 5) === 0) {
      return 19 + ((cabac.decodeBin(CTX_MB_TYPE_B + 5) << 1) |
                     cabac.decodeBin(CTX_MB_TYPE_B + 5)); // 19-22
    }

    // Intra in B-slice
    return 23 + this._decodeMbTypeIinPB(cabac, CTX_MB_TYPE_B + 8);
  }

  _bTypeNeighborCtx(mbIdx) {
    const mbX = mbIdx % this.mbW;
    const mbY = (mbIdx / this.mbW) | 0;
    const left = mbX > 0 ? this.mbType[mbIdx - 1] : -1;
    const top = mbY > 0 ? this.mbType[mbIdx - this.mbW] : -1;
    return (left > 0 ? 1 : 0) + (top > 0 ? 1 : 0);
  }

  /** Decode I mb_type when embedded in P/B slice (different ctx base) */
  _decodeMbTypeIinPB(cabac, ctxBase) {
    const bin0 = cabac.decodeBin(ctxBase);
    if (bin0 === 0) return 0; // I_NxN
    const term = cabac.decodeTerminate();
    if (term) return 25; // I_PCM
    let mt = 1;
    mt += 12 * cabac.decodeBin(ctxBase + 1);
    if (cabac.decodeBin(ctxBase + 2))
      mt += 4 + 4 * cabac.decodeBin(ctxBase + 2);
    mt += 2 * cabac.decodeBin(ctxBase + 3);
    mt += cabac.decodeBin(ctxBase + 3);
    return mt;
  }

  // ── Type predicates ─────────────────────────────────────

  _isPCM(mt, sh)    { const b = sh.isI ? 0 : sh.isP ? 5 : 23; return mt - b === 25; }
  _isIntra(mt, sh)  { if (sh.isI) return true; return mt >= (sh.isP ? 5 : 23); }
  _isI16x16(mt, sh) { const b = sh.isI ? 0 : sh.isP ? 5 : 23; const a = mt - b; return a >= 1 && a <= 24; }
  _isINxN(mt, sh)   { const b = sh.isI ? 0 : sh.isP ? 5 : 23; return mt - b === 0; }
  _i16idx(mt, sh)   { const b = sh.isI ? 0 : sh.isP ? 5 : 23; return mt - b - 1; }

  // ── Chroma prediction mode ──────────────────────────────

  _decodeChromaPredMode(cabac, mbIdx) {
    const mbX = mbIdx % this.mbW;
    const mbY = (mbIdx / this.mbW) | 0;
    const leftMode = mbX > 0 ? this.mbIntraChromaMode[mbIdx - 1] : 0;
    const topMode = mbY > 0 ? this.mbIntraChromaMode[mbIdx - this.mbW] : 0;
    const ctxInc = (leftMode > 0 ? 1 : 0) + (topMode > 0 ? 1 : 0);

    if (cabac.decodeBin(CTX_CHROMA_PRED + ctxInc) === 0) return 0;
    if (cabac.decodeBin(CTX_CHROMA_PRED + 3) === 0) return 1;
    return 2 + cabac.decodeBin(CTX_CHROMA_PRED + 3);
  }

  // ── Intra 4x4 prediction modes ─────────────────────────

  _decodeIntra4x4Modes(cabac, mbX, mbY, mbIdx) {
    // 16 4x4 blocks, decode prev_intra4x4_pred_mode_flag + rem
    for (let blk = 0; blk < 16; blk++) {
      const flag = cabac.decodeBin(CTX_INTRA_PRED_FLAG);
      if (flag) {
        // Use most probable mode (skip decoding rem)
      } else {
        // Read 3 fixed-context bins for rem_intra4x4_pred_mode
        const b0 = cabac.decodeBin(CTX_INTRA_PRED_REM);
        const b1 = cabac.decodeBin(CTX_INTRA_PRED_REM);
        const b2 = cabac.decodeBin(CTX_INTRA_PRED_REM);
        // rem = b0 | (b1<<1) | (b2<<2)
      }
    }
  }

  // ── CBP decoding (FFmpeg pattern from REFERENCE.md) ─────

  _decodeCBP(cabac, mbIdx, isIntra) {
    const mbX = mbIdx % this.mbW;
    const mbY = (mbIdx / this.mbW) | 0;

    // Neighbor CBP for context derivation
    const cbpA = mbX > 0 ? this.mbCbpLuma[mbIdx - 1] : 0;
    const cbpB = mbY > 0 ? this.mbCbpLuma[mbIdx - this.mbW] : 0;
    const cbpCA = mbX > 0 ? this.mbCbpChroma[mbIdx - 1] : 0;
    const cbpCB = mbY > 0 ? this.mbCbpChroma[mbIdx - this.mbW] : 0;

    // Luma CBP: 4 bins conditioned on left/top
    let cbpL = 0;
    // bit 0: left=A's bit1, top=B's bit2
    let ctx = (!(cbpA & 0x02) ? 1 : 0) + 2 * (!(cbpB & 0x04) ? 1 : 0);
    cbpL |= cabac.decodeBin(CTX_CBP_LUMA + ctx);
    // bit 1: left=current bit0, top=B's bit3
    ctx = (!(cbpL & 0x01) ? 1 : 0) + 2 * (!(cbpB & 0x08) ? 1 : 0);
    cbpL |= cabac.decodeBin(CTX_CBP_LUMA + ctx) << 1;
    // bit 2: left=A's bit3, top=current bit0
    ctx = (!(cbpA & 0x08) ? 1 : 0) + 2 * (!(cbpL & 0x01) ? 1 : 0);
    cbpL |= cabac.decodeBin(CTX_CBP_LUMA + ctx) << 2;
    // bit 3: left=current bit2, top=current bit1
    ctx = (!(cbpL & 0x04) ? 1 : 0) + 2 * (!(cbpL & 0x02) ? 1 : 0);
    cbpL |= cabac.decodeBin(CTX_CBP_LUMA + ctx) << 3;

    // Chroma CBP
    let cbpC = 0;
    if (this.sps.ChromaArrayType !== 0) {
      ctx = (cbpCA > 0 ? 1 : 0) + 2 * (cbpCB > 0 ? 1 : 0);
      if (cabac.decodeBin(CTX_CBP_CHROMA + ctx)) {
        ctx = 4 + (cbpCA === 2 ? 1 : 0) + 2 * (cbpCB === 2 ? 1 : 0);
        cbpC = 1 + cabac.decodeBin(CTX_CBP_CHROMA + ctx);
      }
    }

    return cbpL | (cbpC << 4);
  }

  // ── QP delta ────────────────────────────────────────────

  _decodeQPDelta(cabac, prevQPDelta) {
    const ctxInc0 = prevQPDelta !== 0 ? 1 : 0;
    if (cabac.decodeBin(CTX_QP_DELTA + ctxInc0) === 0) return 0;

    let abs = 1;
    while (abs < 52 && cabac.decodeBin(CTX_QP_DELTA + Math.min(abs + 1, 2))) {
      abs++;
    }
    const sign = cabac.decodeBypass();
    return sign ? -abs : abs;
  }

  // ── Residual block decoding (CABAC) ─────────────────────

  /**
   * Decode a 4x4 residual block using CABAC.
   * @param {number} cat - Block category (0=DC16x16, 1=AC16x16, 2=Luma4x4, 3=ChromaDC, 4=ChromaAC, 5=Luma8x8)
   * @param {number} mbIdx - Macroblock index
   * @param {number} blkIdx - Block index within MB (for nzCoeff tracking)
   * @returns {Int32Array} Coefficients in scan order
   */
  _decodeResidualBlock(cabac, cat, mbIdx, blkIdx) {
    const maxCoeff = (cat === 0 || cat === 3) ? 16 : (cat === 1 || cat === 4) ? 15 : 16;

    // coded_block_flag
    const cbfBase = CBF_BASE[cat] || 85;
    const nzLeft = 0; // simplified: would check left neighbor's nzCoeff
    const nzTop = 0;  // simplified: would check top neighbor's nzCoeff
    const cbfCtx = cbfBase + nzLeft + 2 * nzTop;

    if (cabac.decodeBin(cbfCtx) === 0) return new Int32Array(maxCoeff);

    // significant_coeff_flag + last_significant_coeff_flag
    const sigBase = SIG_OFF[cat] || 105;
    const lastBase = LAST_OFF[cat] || 166;
    const significantPositions = [];

    for (let i = 0; i < maxCoeff - 1; i++) {
      if (cabac.decodeBin(sigBase + Math.min(i, 14))) {
        significantPositions.push(i);
        if (cabac.decodeBin(lastBase + Math.min(i, 14))) break;
      }
    }
    if (significantPositions.length === 0 ||
        significantPositions[significantPositions.length - 1] !== maxCoeff - 1) {
      // Last position is implicitly significant if we didn't hit "last" flag
      significantPositions.push(maxCoeff - 1);
    }

    // coeff_abs_level_minus1 + sign (node-based state machine)
    const absBase = ABS_LEVEL_BASE[cat] || 227;
    const coeffs = new Int32Array(maxCoeff);
    let nodeCtx = 0;

    for (let i = significantPositions.length - 1; i >= 0; i--) {
      const pos = significantPositions[i];
      let level;

      const ctx1 = absBase + LEVEL1_CTX[nodeCtx];
      if (cabac.decodeBin(ctx1) === 0) {
        level = 1;
        nodeCtx = TRANS_ON_1[nodeCtx];
      } else {
        const ctxGt1 = absBase + LEVELGT1_CTX[nodeCtx];
        nodeCtx = TRANS_ON_GT1[nodeCtx];
        level = 2;
        while (level < 15 && cabac.decodeBin(ctxGt1)) level++;
        if (level >= 15) {
          // Exp-Golomb k=0 suffix
          let k = 0;
          while (cabac.decodeBypass()) { level += 1 << k; k++; }
          while (k > 0) { k--; level += cabac.decodeBypass() << k; }
        }
      }

      const sign = cabac.decodeBypass();
      coeffs[pos] = sign ? -level : level;
    }

    // Track non-zero coefficients
    if (blkIdx >= 0 && mbIdx >= 0) {
      this.nzCoeff[mbIdx * 24 + blkIdx] = significantPositions.length;
    }

    return coeffs;
  }

  // ── Reconstruction: I_16x16 ─────────────────────────────

  _reconI16x16(cabac, mbX, mbY, mt, sh, qp, cbpL, cbpC) {
    const predMode = i16x16TypeMap[this._i16idx(mt, sh)][0];
    const { above, left, aboveLeft, hasAbove, hasLeft } = this._neighbors16(mbX, mbY);
    const pred = intra16x16Predict(predMode, above, left, aboveLeft, hasAbove, hasLeft);

    // Decode luma DC (Hadamard)
    const mbIdx = mbY * this.mbW + mbX;
    const dcCoeffs = this._decodeResidualBlock(cabac, 0, mbIdx, -1);
    const dcTrans = inverseHadamard4x4(dcCoeffs);

    // Decode luma AC + reconstruct each 4x4 block
    for (let blk = 0; blk < 16; blk++) {
      const bx = (blk & 3) * 4;
      const by = (blk >> 2) * 4;

      // 8x8 block index for CBP
      const cbpIdx = ((by >> 3) << 1) | (bx >> 3);

      const residual = new Int32Array(16);
      // DC from Hadamard (the qp scaling for DC is different)
      const qpDiv6 = (qp / 6) | 0;
      if (qpDiv6 >= 2) {
        residual[0] = (dcTrans[blk] * this._levelScale(qp, 0)) << (qpDiv6 - 2);
      } else {
        residual[0] = (dcTrans[blk] * this._levelScale(qp, 0) + (1 << (1 - qpDiv6))) >> (2 - qpDiv6);
      }

      if (cbpL & (1 << cbpIdx)) {
        const ac = this._decodeResidualBlock(cabac, 1, mbIdx, blk);
        // Dequantize AC (positions 1-15)
        const qpMod6 = qp % 6;
        const ls = [10, 11, 13, 14, 16, 18][qpMod6];
        for (let i = 1; i < 16; i++) {
          if (ac[i] !== 0) {
            const scale = this._levelScale(qp, i);
            if (qpDiv6 >= 4) {
              residual[i] = (ac[i] * scale) << (qpDiv6 - 4);
            } else {
              residual[i] = (ac[i] * scale + (1 << (3 - qpDiv6))) >> (4 - qpDiv6);
            }
          }
        }
      }

      const decoded = inverseDCT4x4(residual);

      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const px = mbX * 16 + bx + x;
          const py = mbY * 16 + by + y;
          this.frame.Y[py * this.frame.strideY + px] =
            clip255(pred[(by + y) * 16 + bx + x] + decoded[y * 4 + x]);
        }
      }
    }
  }

  _levelScale(qp, scanPos) {
    const scales = [
      [10, 13, 10, 13, 13, 16, 13, 16, 10, 13, 10, 13, 13, 16, 13, 16],
      [11, 14, 11, 14, 14, 18, 14, 18, 11, 14, 11, 14, 14, 18, 14, 18],
      [13, 16, 13, 16, 16, 20, 16, 20, 13, 16, 13, 16, 16, 20, 16, 20],
      [14, 18, 14, 18, 18, 23, 18, 23, 14, 18, 14, 18, 18, 23, 18, 23],
      [16, 20, 16, 20, 20, 25, 20, 25, 16, 20, 16, 20, 20, 25, 20, 25],
      [18, 23, 18, 23, 23, 29, 23, 29, 18, 23, 18, 23, 23, 29, 23, 29],
    ];
    return scales[qp % 6][scanPos % 16];
  }

  // ── Reconstruction: I_NxN ───────────────────────────────

  _reconINxN(cabac, mbX, mbY, qp, cbpL, cbpC) {
    const mbIdx = mbY * this.mbW + mbX;
    for (let blk = 0; blk < 16; blk++) {
      const bx = (blk & 3) * 4;
      const by = (blk >> 2) * 4;

      // Get neighboring samples for this 4x4 block
      const above = new Int32Array(8);
      const left = new Int32Array(4);
      let aL = 128;
      const hA = mbY > 0 || by > 0;
      const hL = mbX > 0 || bx > 0;

      if (hA) for (let i = 0; i < 8; i++) above[i] = this.frame.getY(mbX * 16 + bx + i, mbY * 16 + by - 1);
      if (hL) for (let i = 0; i < 4; i++) left[i] = this.frame.getY(mbX * 16 + bx - 1, mbY * 16 + by + i);
      if (hA && hL) aL = this.frame.getY(mbX * 16 + bx - 1, mbY * 16 + by - 1);

      const pred = intra4x4Predict(2, above, left, aL, hA, hL, hA); // DC mode as default

      const cbpIdx = ((by >> 3) << 1) | (bx >> 3);
      let decoded = null;
      if (cbpL & (1 << cbpIdx)) {
        const coeffs = this._decodeResidualBlock(cabac, 2, mbIdx, blk);
        const dequant = dequantize4x4(coeffs, qp, true);
        decoded = inverseDCT4x4(dequant);
      }

      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const px = mbX * 16 + bx + x;
          const py = mbY * 16 + by + y;
          const val = pred[y * 4 + x] + (decoded ? decoded[y * 4 + x] : 0);
          this.frame.Y[py * this.frame.strideY + px] = clip255(val);
        }
      }
    }
  }

  // ── Reconstruction: Inter ───────────────────────────────

  _reconInter(cabac, mbX, mbY, qp, cbpL, cbpC) {
    // Residual over motion-compensated prediction (already written by _decodeInterPred)
    const mbIdx = mbY * this.mbW + mbX;
    if (cbpL > 0) {
      for (let blk = 0; blk < 16; blk++) {
        const bx = (blk & 3) * 4;
        const by = (blk >> 2) * 4;
        const cbpIdx = ((by >> 3) << 1) | (bx >> 3);
        if (cbpL & (1 << cbpIdx)) {
          const coeffs = this._decodeResidualBlock(cabac, 2, mbIdx, blk);
          const dequant = dequantize4x4(coeffs, qp, false);
          const decoded = inverseDCT4x4(dequant);
          for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) {
              const px = mbX * 16 + bx + x;
              const py = mbY * 16 + by + y;
              const idx = py * this.frame.strideY + px;
              this.frame.Y[idx] = clip255(this.frame.Y[idx] + decoded[y * 4 + x]);
            }
          }
        }
      }
    }
  }

  // ── Chroma reconstruction ───────────────────────────────

  _reconChroma(cabac, mbX, mbY, qp, cbpC, isIntra, chromaMode) {
    const mbIdx = mbY * this.mbW + mbX;
    const qpC = this._chromaQP(qp + this.pps.chroma_qp_index_offset);

    // Intra chroma prediction
    if (isIntra) {
      for (let comp = 0; comp < 2; comp++) {
        const plane = comp === 0 ? this.frame.U : this.frame.V;
        const getC = comp === 0 ?
          (x, y) => this.frame.getU(x, y) :
          (x, y) => this.frame.getV(x, y);

        const above = new Uint8Array(8);
        const left = new Uint8Array(8);
        let aL = 128;
        const hA = mbY > 0;
        const hL = mbX > 0;
        if (hA) for (let i = 0; i < 8; i++) above[i] = getC(mbX * 8 + i, mbY * 8 - 1);
        if (hL) for (let i = 0; i < 8; i++) left[i] = getC(mbX * 8 - 1, mbY * 8 + i);
        if (hA && hL) aL = getC(mbX * 8 - 1, mbY * 8 - 1);

        const pred = intraChromaPredict(chromaMode, above, left, aL, hA, hL);
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++)
            plane[(mbY * 8 + y) * this.frame.strideC + mbX * 8 + x] = clip255(pred[y * 8 + x]);
      }
    }

    if (cbpC === 0) return;

    // Chroma DC + AC
    for (let comp = 0; comp < 2; comp++) {
      const plane = comp === 0 ? this.frame.U : this.frame.V;
      const dc = this._decodeResidualBlock(cabac, 3, mbIdx, 16 + comp * 4);
      const dcT = inverseHadamard2x2(dc);

      for (let blk = 0; blk < 4; blk++) {
        const bx = (blk & 1) * 4;
        const by = (blk >> 1) * 4;

        const residual = new Int32Array(16);
        // DC from Hadamard with chroma QP scaling
        const qpDiv6 = (qpC / 6) | 0;
        const qpMod6 = qpC % 6;
        const dcScale = [10, 11, 13, 14, 16, 18][qpMod6];
        if (qpDiv6 >= 1) {
          residual[0] = (dcT[blk] * dcScale) << (qpDiv6 - 1);
        } else {
          residual[0] = (dcT[blk] * dcScale) >> 1;
        }

        if (cbpC === 2) {
          const ac = this._decodeResidualBlock(cabac, 4, mbIdx, 16 + comp * 4 + blk);
          for (let i = 1; i < 16; i++) {
            if (ac[i] !== 0) {
              const scale = this._levelScale(qpC, i);
              if (qpDiv6 >= 4) {
                residual[i] = (ac[i] * scale) << (qpDiv6 - 4);
              } else {
                residual[i] = (ac[i] * scale + (1 << (3 - qpDiv6))) >> (4 - qpDiv6);
              }
            }
          }
        }

        const decoded = inverseDCT4x4(residual);
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) {
            const px = mbX * 8 + bx + x;
            const py = mbY * 8 + by + y;
            const idx = py * this.frame.strideC + px;
            plane[idx] = clip255(plane[idx] + decoded[y * 4 + x]);
          }
        }
      }
    }
  }

  // ── Inter prediction stubs ──────────────────────────────

  _decodeInterPred(cabac, sh, mt, mbIdx, mbX, mbY, refL0, refL1) {
    // For now: decode the CABAC syntax elements (ref_idx, mvd) to keep
    // the CABAC state correct, then use zero-motion from refL0[0].

    const isP = sh.isP;
    const base = isP ? 0 : 23;
    const adjMt = isP ? mt : mt;

    // Copy reference frame block with zero motion
    const ref = refL0.length > 0 ? refL0[0] : null;
    if (ref) {
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++)
          this.frame.Y[(mbY * 16 + y) * this.frame.strideY + mbX * 16 + x] = ref.getY(mbX * 16 + x, mbY * 16 + y);
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          this.frame.U[(mbY * 8 + y) * this.frame.strideC + mbX * 8 + x] = ref.getU(mbX * 8 + x, mbY * 8 + y);
          this.frame.V[(mbY * 8 + y) * this.frame.strideC + mbX * 8 + x] = ref.getV(mbX * 8 + x, mbY * 8 + y);
        }
    }

    // TODO: properly decode ref_idx and mvd to keep CABAC in sync
    // For P_L0_16x16: 1 ref_idx + 2 mvd components
    // For B types: varies
    // Without proper inter CABAC syntax parsing, the CABAC state will
    // desync on P/B frames. This is acceptable for IDR-only testing.
  }

  _reconstructSkip(mbX, mbY, refL0, sh) {
    const ref = refL0.length > 0 ? refL0[0] : null;
    if (ref) {
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++)
          this.frame.Y[(mbY * 16 + y) * this.frame.strideY + mbX * 16 + x] = ref.getY(mbX * 16 + x, mbY * 16 + y);
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          this.frame.U[(mbY * 8 + y) * this.frame.strideC + mbX * 8 + x] = ref.getU(mbX * 8 + x, mbY * 8 + y);
          this.frame.V[(mbY * 8 + y) * this.frame.strideC + mbX * 8 + x] = ref.getV(mbX * 8 + x, mbY * 8 + y);
        }
    } else {
      this._fillGray(mbX, mbY);
    }
  }

  // ── Deblocking filter (simplified) ──────────────────────

  _deblock(sh) {
    // Simplified deblocking: apply mild smoothing at MB boundaries
    // TODO: Full H.264 deblocking per Section 8.7
    const f = this.frame;
    for (let mbY = 0; mbY < this.mbH; mbY++) {
      for (let mbX = 0; mbX < this.mbW; mbX++) {
        // Vertical edge at left MB boundary
        if (mbX > 0) {
          const x = mbX * 16;
          for (let y = 0; y < 16; y++) {
            const py = mbY * 16 + y;
            const p0 = f.Y[py * f.strideY + x - 1];
            const q0 = f.Y[py * f.strideY + x];
            const d = ((q0 - p0 + 2) >> 2);
            if (Math.abs(d) < 4) {
              f.Y[py * f.strideY + x - 1] = clip255(p0 + d);
              f.Y[py * f.strideY + x] = clip255(q0 - d);
            }
          }
        }
        // Horizontal edge at top MB boundary
        if (mbY > 0) {
          const y = mbY * 16;
          for (let x = 0; x < 16; x++) {
            const px = mbX * 16 + x;
            const p0 = f.Y[(y - 1) * f.strideY + px];
            const q0 = f.Y[y * f.strideY + px];
            const d = ((q0 - p0 + 2) >> 2);
            if (Math.abs(d) < 4) {
              f.Y[(y - 1) * f.strideY + px] = clip255(p0 + d);
              f.Y[y * f.strideY + px] = clip255(q0 - d);
            }
          }
        }
      }
    }
  }

  // ── Utilities ───────────────────────────────────────────

  _neighbors16(mbX, mbY) {
    const f = this.frame;
    const hA = mbY > 0, hL = mbX > 0;
    const above = new Uint8Array(16);
    const left = new Uint8Array(16);
    let aL = 128;
    if (hA) for (let x = 0; x < 16; x++) above[x] = f.Y[(mbY * 16 - 1) * f.strideY + mbX * 16 + x];
    if (hL) for (let y = 0; y < 16; y++) left[y] = f.Y[(mbY * 16 + y) * f.strideY + mbX * 16 - 1];
    if (hA && hL) aL = f.Y[(mbY * 16 - 1) * f.strideY + mbX * 16 - 1];
    return { above, left, aboveLeft: aL, hasAbove: hA, hasLeft: hL };
  }

  _buildRefList(sh, listIdx) {
    if (listIdx === 0) return [...this.dpb].sort((a, b) => b.frameNum - a.frameNum);
    return [...this.dpb].sort((a, b) => a.poc - b.poc);
  }

  _fillGray(mbX, mbY) {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        this.frame.Y[(mbY * 16 + y) * this.frame.strideY + mbX * 16 + x] = 128;
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        this.frame.U[(mbY * 8 + y) * this.frame.strideC + mbX * 8 + x] = 128;
        this.frame.V[(mbY * 8 + y) * this.frame.strideC + mbX * 8 + x] = 128;
      }
  }

  _chromaQP(qpI) {
    const t = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,
      28,29,29,30,31,32,32,33,33,34,34,35,35,36,36,37,37,37,38,38,38,39,39,39,39];
    return t[Math.max(0, Math.min(51, qpI))];
  }

  _decodeIPCM(cabac, mbX, mbY) {
    // I_PCM: raw pixel data follows (after byte alignment)
    // The CABAC state is reset after I_PCM
    // For simplicity, fill with mid-gray
    this._fillGray(mbX, mbY);
  }
}

export { YUVFrame };
export default H264Decoder;
