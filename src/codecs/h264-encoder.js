/**
 * H.264 I-Frame Encoder (Baseline Profile, CAVLC)
 *
 * Encodes a single YUV frame as an H.264 IDR (keyframe) using
 * Baseline profile with CAVLC entropy coding. Produces SPS, PPS,
 * and IDR slice NAL units.
 *
 * Used by the HLS clipper for smart-rendering: the decoded frame
 * at the clip start is re-encoded as a new keyframe.
 *
 * @module codecs/h264-encoder
 */

import { forwardDCT4x4, forwardHadamard4x4, forwardHadamard2x2, quantize4x4, clip255 } from './h264-transform.js';
import { scanOrder4x4 } from './h264-tables.js';
import { getCoeffToken, getTotalZeros, getTotalZerosChromaDC, getRunBefore, encodeLevels } from './h264-cavlc-tables.js';

// ── Bitstream Writer ──────────────────────────────────────

class BitstreamWriter {
  constructor(capacity = 65536) {
    this.data = new Uint8Array(capacity);
    this.bytePos = 0;
    this.bitPos = 0; // bits written in current byte (0-7)
  }

  _grow() {
    const newData = new Uint8Array(this.data.length * 2);
    newData.set(this.data);
    this.data = newData;
  }

  writeBit(bit) {
    if (this.bytePos >= this.data.length) this._grow();
    this.data[this.bytePos] |= (bit & 1) << (7 - this.bitPos);
    this.bitPos++;
    if (this.bitPos === 8) {
      this.bitPos = 0;
      this.bytePos++;
    }
  }

  writeBits(value, n) {
    for (let i = n - 1; i >= 0; i--) {
      this.writeBit((value >> i) & 1);
    }
  }

  /** Unsigned Exp-Golomb */
  writeUE(value) {
    if (value === 0) {
      this.writeBit(1);
      return;
    }
    const val = value + 1;
    const numBits = 32 - Math.clz32(val);
    const zeros = numBits - 1;
    for (let i = 0; i < zeros; i++) this.writeBit(0);
    this.writeBits(val, numBits);
  }

  /** Signed Exp-Golomb */
  writeSE(value) {
    if (value === 0) { this.writeUE(0); return; }
    this.writeUE(value > 0 ? 2 * value - 1 : -2 * value);
  }

  /** Write RBSP trailing bits (stop bit + alignment) */
  writeTrailingBits() {
    this.writeBit(1);
    while (this.bitPos !== 0) this.writeBit(0);
  }

  /** Get the written data as Uint8Array */
  toUint8Array() {
    const len = this.bitPos > 0 ? this.bytePos + 1 : this.bytePos;
    return this.data.slice(0, len);
  }
}

// ── Emulation Prevention ──────────────────────────────────

function addEmulationPrevention(rbsp) {
  const result = [];
  for (let i = 0; i < rbsp.length; i++) {
    if (i >= 2 && rbsp[i - 2] === 0 && rbsp[i - 1] === 0 && rbsp[i] <= 3) {
      result.push(0x03); // emulation prevention byte
    }
    result.push(rbsp[i]);
  }
  return new Uint8Array(result);
}

// ── CAVLC Tables ──────────────────────────────────────────

// coeff_token VLC tables (Table 9-5)
// Indexed by [nC_range][TotalCoeff][TrailingOnes] → [code, length]
// nC_range: 0 (0-1), 1 (2-3), 2 (4-7), 3 (8+)
// This is a large table; we include the most common entries.
// Format: cavlcCoeffToken[nC][totalCoeff][trailingOnes] = [code, codelen]

function buildCoeffTokenTable() {
  // Table 9-5(a): 0 <= nC < 2
  const t0 = [];
  // [totalCoeff][trailingOnes] = [code, bits]
  t0[0] = [[1, 1]]; // (0,0)
  t0[1] = [[5, 6], [1, 2]]; // (1,0), (1,1)
  t0[2] = [[7, 8], [4, 6], [1, 3]]; // (2,0), (2,1), (2,2)
  t0[3] = [[7, 9], [6, 8], [5, 7], [3, 5]]; // (3,0)...(3,3)
  t0[4] = [[7, 10], [6, 9], [5, 8], [3, 6]];
  t0[5] = [[7, 11], [6, 10], [5, 9], [4, 7]];
  t0[6] = [[15, 13], [6, 11], [5, 10], [4, 8]];
  t0[7] = [[11, 13], [14, 13], [5, 11], [4, 9]];
  t0[8] = [[8, 13], [10, 13], [13, 13], [4, 10]];
  t0[9] = [[15, 14], [14, 14], [9, 13], [4, 11]];
  t0[10] = [[11, 14], [10, 14], [13, 14], [12, 13]];
  t0[11] = [[15, 15], [14, 15], [9, 14], [12, 14]];
  t0[12] = [[11, 15], [10, 15], [13, 15], [8, 14]];
  t0[13] = [[15, 16], [1, 15], [9, 15], [12, 15]];
  t0[14] = [[11, 16], [14, 16], [13, 16], [8, 15]];
  t0[15] = [[7, 16], [10, 16], [9, 16], [12, 16]];
  t0[16] = [[4, 16], [6, 16], [5, 16], [8, 16]];

  // Table 9-5(b): 2 <= nC < 4
  const t1 = [];
  t1[0] = [[3, 2]];
  t1[1] = [[11, 6], [2, 2]];
  t1[2] = [[7, 6], [7, 5], [3, 3]];
  t1[3] = [[7, 7], [10, 6], [9, 6], [5, 4]];
  t1[4] = [[7, 8], [6, 6], [5, 6], [4, 4]];
  t1[5] = [[4, 8], [6, 7], [5, 7], [6, 5]];
  t1[6] = [[7, 9], [6, 8], [5, 8], [8, 6]];
  t1[7] = [[15, 11], [6, 9], [5, 9], [4, 6]];
  t1[8] = [[11, 11], [14, 11], [13, 11], [4, 7]];
  t1[9] = [[15, 12], [10, 11], [9, 11], [4, 8]];
  t1[10] = [[11, 12], [14, 12], [13, 12], [12, 11]];
  t1[11] = [[8, 12], [10, 12], [9, 12], [8, 11]];
  t1[12] = [[15, 13], [14, 13], [13, 13], [12, 12]];
  t1[13] = [[11, 13], [10, 13], [9, 13], [12, 13]];
  t1[14] = [[7, 13], [11, 14], [6, 13], [8, 13]];
  t1[15] = [[9, 14], [8, 14], [10, 14], [1, 13]];
  t1[16] = [[7, 14], [6, 14], [5, 14], [4, 14]];

  return [t0, t1];
}

const CAVLC_COEFF_TOKEN = buildCoeffTokenTable();

// ── Intra 16x16 Prediction for Encoder ────────────────────

function predictDC16x16(above, left, hasAbove, hasLeft) {
  let sum = 0, count = 0;
  if (hasAbove) { for (let i = 0; i < 16; i++) sum += above[i]; count += 16; }
  if (hasLeft) { for (let i = 0; i < 16; i++) sum += left[i]; count += 16; }
  return count > 0 ? (sum + (count >> 1)) / count | 0 : 128;
}

// ── H.264 I-Frame Encoder ─────────────────────────────────

export class H264Encoder {
  /**
   * Encode a YUV frame as H.264 IDR NAL units.
   *
   * @param {Uint8Array} Y - Luma plane (width * height)
   * @param {Uint8Array} U - Chroma U plane ((width/2) * (height/2))
   * @param {Uint8Array} V - Chroma V plane ((width/2) * (height/2))
   * @param {number} width - Frame width (must be multiple of 16)
   * @param {number} height - Frame height (must be multiple of 16)
   * @param {number} [qp=26] - Quantization parameter (0-51, lower = better quality)
   * @returns {Array<Uint8Array>} Array of NAL units [SPS, PPS, IDR]
   */
  encode(Y, U, V, width, height, qp = 26) {
    const mbW = width >> 4;
    const mbH = height >> 4;

    const sps = this._buildSPS(width, height);
    const pps = this._buildPPS();
    const idr = this._buildIDRSlice(Y, U, V, width, height, mbW, mbH, qp);

    return [sps, pps, idr];
  }

  // ── SPS (Baseline Profile) ──────────────────────────────

  _buildSPS(width, height) {
    const mbW = width >> 4;
    const mbH = height >> 4;
    const bs = new BitstreamWriter(64);

    // NAL header: forbidden_zero_bit=0, nal_ref_idc=3, nal_unit_type=7
    bs.writeBits(0x67, 8);

    // profile_idc=66 (Baseline)
    bs.writeBits(66, 8);
    // constraint_set0_flag=1, rest=0, reserved=0
    bs.writeBits(0x40, 8);
    // level_idc=40 (4.0)
    bs.writeBits(40, 8);
    // seq_parameter_set_id=0
    bs.writeUE(0);
    // log2_max_frame_num_minus4=0
    bs.writeUE(0);
    // pic_order_cnt_type=0
    bs.writeUE(0);
    // log2_max_pic_order_cnt_lsb_minus4=0
    bs.writeUE(0);
    // max_num_ref_frames=0 (I-only)
    bs.writeUE(0);
    // gaps_in_frame_num_value_allowed_flag=0
    bs.writeBit(0);
    // pic_width_in_mbs_minus1
    bs.writeUE(mbW - 1);
    // pic_height_in_map_units_minus1
    bs.writeUE(mbH - 1);
    // frame_mbs_only_flag=1
    bs.writeBit(1);
    // direct_8x8_inference_flag=0
    bs.writeBit(0);
    // frame_cropping_flag=0
    bs.writeBit(0);
    // vui_parameters_present_flag=0
    bs.writeBit(0);

    bs.writeTrailingBits();
    return addEmulationPrevention(bs.toUint8Array());
  }

  // ── PPS ─────────────────────────────────────────────────

  _buildPPS() {
    const bs = new BitstreamWriter(32);

    // NAL header: nal_ref_idc=3, nal_unit_type=8
    bs.writeBits(0x68, 8);

    // pic_parameter_set_id=0
    bs.writeUE(0);
    // seq_parameter_set_id=0
    bs.writeUE(0);
    // entropy_coding_mode_flag=0 (CAVLC)
    bs.writeBit(0);
    // bottom_field_pic_order_in_frame_present_flag=0
    bs.writeBit(0);
    // num_slice_groups_minus1=0
    bs.writeUE(0);
    // num_ref_idx_l0_default_active_minus1=0
    bs.writeUE(0);
    // num_ref_idx_l1_default_active_minus1=0
    bs.writeUE(0);
    // weighted_pred_flag=0
    bs.writeBit(0);
    // weighted_bipred_idc=0
    bs.writeBits(0, 2);
    // pic_init_qp_minus26=0
    bs.writeSE(0);
    // pic_init_qs_minus26=0
    bs.writeSE(0);
    // chroma_qp_index_offset=0
    bs.writeSE(0);
    // deblocking_filter_control_present_flag=1
    bs.writeBit(1);
    // constrained_intra_pred_flag=0
    bs.writeBit(0);
    // redundant_pic_cnt_present_flag=0
    bs.writeBit(0);

    bs.writeTrailingBits();
    return addEmulationPrevention(bs.toUint8Array());
  }

  // ── IDR Slice ───────────────────────────────────────────

  _buildIDRSlice(Y, U, V, width, height, mbW, mbH, qp) {
    const bs = new BitstreamWriter(width * height); // generous initial capacity

    // NAL header: nal_ref_idc=3, nal_unit_type=5 (IDR)
    bs.writeBits(0x65, 8);

    // Slice header
    bs.writeUE(0);  // first_mb_in_slice=0
    bs.writeUE(7);  // slice_type=7 (I, all MBs)
    bs.writeUE(0);  // pic_parameter_set_id=0
    bs.writeBits(0, 4); // frame_num=0 (log2_max_frame_num=4 bits)
    bs.writeUE(0);  // idr_pic_id=0
    bs.writeBits(0, 4); // pic_order_cnt_lsb=0 (4 bits)
    // dec_ref_pic_marking: no_output_of_prior=0, long_term_ref=0
    bs.writeBit(0);
    bs.writeBit(0);
    // slice_qp_delta
    bs.writeSE(qp - 26);
    // deblocking: disable_deblocking_filter_idc=1 (disabled for simplicity)
    bs.writeUE(1);

    // Encode macroblocks
    for (let mbY = 0; mbY < mbH; mbY++) {
      for (let mbX = 0; mbX < mbW; mbX++) {
        this._encodeMB(bs, Y, U, V, width, height, mbX, mbY, mbW, qp);
      }
    }

    bs.writeTrailingBits();
    return addEmulationPrevention(bs.toUint8Array());
  }

  // ── Macroblock Encoding ─────────────────────────────────

  _encodeMB(bs, Y, U, V, width, height, mbX, mbY, mbW, qp) {
    const strideY = width;
    const strideC = width >> 1;
    const hasAbove = mbY > 0;
    const hasLeft = mbX > 0;

    // Get neighbor samples for prediction
    const above = new Uint8Array(16);
    const left = new Uint8Array(16);
    if (hasAbove) for (let i = 0; i < 16; i++) above[i] = Y[(mbY * 16 - 1) * strideY + mbX * 16 + i];
    if (hasLeft) for (let i = 0; i < 16; i++) left[i] = Y[(mbY * 16 + i) * strideY + mbX * 16 - 1];

    // Use I_16x16 with DC prediction (mode 2)
    const dcPred = predictDC16x16(above, left, hasAbove, hasLeft);

    // Compute residual for each 4x4 block
    const dcCoeffs = new Int32Array(16); // DC values for Hadamard
    const acBlocks = []; // AC coefficients per block
    let hasAC = false;

    for (let blk = 0; blk < 16; blk++) {
      const bx = (blk & 3) * 4;
      const by = (blk >> 2) * 4;

      // Compute residual
      const residual = new Int32Array(16);
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const px = mbX * 16 + bx + x;
          const py = mbY * 16 + by + y;
          residual[y * 4 + x] = Y[py * strideY + px] - dcPred;
        }
      }

      // Forward DCT
      const coeffs = forwardDCT4x4(residual);

      // Quantize
      const quantized = quantize4x4(coeffs, qp);

      // DC coefficient goes to Hadamard
      dcCoeffs[blk] = quantized[0];

      // AC coefficients
      const ac = new Int32Array(15);
      for (let i = 1; i < 16; i++) ac[i - 1] = quantized[i];
      acBlocks.push(ac);

      for (let i = 0; i < 15; i++) {
        if (ac[i] !== 0) { hasAC = true; break; }
      }
    }

    // Hadamard transform on DC coefficients
    const dcHadamard = forwardHadamard4x4(dcCoeffs);
    // Quantize DC (simplified: divide by QP step)
    const dcQuantized = new Int32Array(16);
    const qpDiv6 = (qp / 6) | 0;
    const qpMod6 = qp % 6;
    const dcMF = [13107, 11916, 10082, 9362, 8192, 7282][qpMod6];
    for (let i = 0; i < 16; i++) {
      const sign = dcHadamard[i] < 0 ? -1 : 1;
      dcQuantized[i] = sign * ((Math.abs(dcHadamard[i]) * dcMF + (1 << (15 + qpDiv6)) / 3) >> (16 + qpDiv6));
    }

    let hasDC = false;
    for (let i = 0; i < 16; i++) if (dcQuantized[i] !== 0) { hasDC = true; break; }

    // Determine mb_type
    // I_16x16_pred_cbpL_cbpC: pred=2(DC), cbpL=hasAC?15:0, cbpC=0
    const cbpLuma = hasAC ? 15 : 0;
    const cbpChroma = 0; // simplified: skip chroma residual
    const predMode = 2; // DC

    // mb_type = 1 + predMode + cbpChroma*4 + (cbpLuma>0 ? 12 : 0)
    // For I_16x16 in I-slice: mb_type 1-24, mapped to UE codenum
    const mbType = 1 + predMode + cbpChroma * 4 + (cbpLuma > 0 ? 12 : 0);
    bs.writeUE(mbType);

    // intra_chroma_pred_mode = 0 (DC) — required for ALL intra MBs
    bs.writeUE(0);

    // mb_qp_delta = 0 (first MB uses slice QP)
    bs.writeSE(0);

    // Encode DC Hadamard block (CAVLC)
    this._encodeCavlcBlock(bs, dcQuantized, 16, 0);

    // Encode AC blocks (if cbpLuma != 0)
    if (cbpLuma > 0) {
      for (let blk = 0; blk < 16; blk++) {
        this._encodeCavlcBlock(bs, acBlocks[blk], 15, 0);
      }
    }

    // Chroma: encode minimal (DC-only, all zeros for simplified encoder)
    // For cbpChroma=0, no chroma residual is encoded
    // (The chroma prediction handles the base values)
  }

  // ── CAVLC Block Encoding (using spec-correct tables) ────

  /**
   * Encode a residual block using CAVLC with the correct VLC tables
   * from the H.264 spec (Tables 9-5 through 9-10).
   *
   * @param {BitstreamWriter} bs - Output bitstream
   * @param {Int32Array} coeffs - Quantized coefficients in scan order
   * @param {number} maxCoeff - Maximum coefficients (16 for 4x4, 15 for AC)
   * @param {number} nC - Predicted number of non-zero coefficients
   */
  _encodeCavlcBlock(bs, coeffs, maxCoeff, nC) {
    // Step 1: Analyze coefficients in reverse scan order
    // Find non-zero coefficients and count trailing ones
    const nonZeroValues = []; // level values in reverse scan order
    const nonZeroPositions = []; // scan positions

    for (let i = maxCoeff - 1; i >= 0; i--) {
      if (coeffs[i] !== 0) {
        nonZeroValues.push(coeffs[i]);
        nonZeroPositions.push(i);
      }
    }

    const totalCoeff = nonZeroValues.length;

    // Count trailing ones (T1s): consecutive +/-1 at the END of the non-zero list
    // In reverse scan order, these are at the BEGINNING of nonZeroValues
    let trailingOnes = 0;
    for (let i = 0; i < Math.min(totalCoeff, 3); i++) {
      if (Math.abs(nonZeroValues[i]) === 1) trailingOnes++;
      else break;
    }

    // Step 2: Write coeff_token
    const [ctBits, ctLen] = getCoeffToken(totalCoeff, trailingOnes, nC);
    bs.writeBits(ctBits, ctLen);

    if (totalCoeff === 0) return;

    // Step 3: Write trailing ones sign flags (1 bit each, 0=positive, 1=negative)
    for (let i = 0; i < trailingOnes; i++) {
      bs.writeBit(nonZeroValues[i] < 0 ? 1 : 0);
    }

    // Step 4: Write remaining levels (non-trailing-ones, still in reverse scan order)
    if (totalCoeff > trailingOnes) {
      const remainingLevels = nonZeroValues.slice(trailingOnes);
      const { bits: levelBits, lengths: levelLens } = encodeLevels(
        remainingLevels, trailingOnes, totalCoeff
      );
      for (let i = 0; i < levelBits.length; i++) {
        // Write prefix (zeros + 1)
        const prefix = levelLens[i] - (levelLens[i] > 0 ? 0 : 0);
        // encodeLevels returns {bits, length} — write directly
        bs.writeBits(levelBits[i], levelLens[i]);
      }
    }

    // Step 5: Write total_zeros (only if totalCoeff < maxCoeff)
    if (totalCoeff < maxCoeff) {
      // Count total zeros before (and between) the non-zero coefficients
      let lastNonZeroPos = 0;
      for (let i = maxCoeff - 1; i >= 0; i--) {
        if (coeffs[i] !== 0) { lastNonZeroPos = i; break; }
      }
      let totalZeros = 0;
      for (let i = 0; i <= lastNonZeroPos; i++) {
        if (coeffs[i] === 0) totalZeros++;
      }

      const [tzBits, tzLen] = getTotalZeros(totalCoeff, totalZeros);
      bs.writeBits(tzBits, tzLen);

      // Step 6: Write run_before for each coefficient (reverse scan order)
      // except the last one (its position is implied)
      let zerosLeft = totalZeros;
      for (let i = 0; i < totalCoeff - 1 && zerosLeft > 0; i++) {
        const pos = nonZeroPositions[i];
        // Count consecutive zeros before this coefficient in scan order
        let run = 0;
        for (let j = pos - 1; j >= 0; j--) {
          if (coeffs[j] === 0) run++;
          else break;
        }
        run = Math.min(run, zerosLeft);

        const [rbBits, rbLen] = getRunBefore(zerosLeft, run);
        bs.writeBits(rbBits, rbLen);
        zerosLeft -= run;
      }
    }
  }
}

export default H264Encoder;
