/**
 * H.264 SPS and PPS Parsers
 *
 * Full parsing of Sequence Parameter Set and Picture Parameter Set
 * NAL units, extracting all fields needed for decoding.
 *
 * Reference: ITU-T H.264, Section 7.3.2.1 (SPS) and 7.3.2.2 (PPS)
 *
 * @module codecs/h264-sps-pps
 */

import { BitstreamReader, removeEmulationPrevention } from './h264-cabac.js';

// ══════════════════════════════════════════════════════════
// SPS Parser
// ══════════════════════════════════════════════════════════

/**
 * Parse a full Sequence Parameter Set.
 * @param {Uint8Array} nalUnit - SPS NAL unit data (including NAL header byte)
 * @returns {object} Parsed SPS fields
 */
export function parseSPSFull(nalUnit) {
  const rbsp = removeEmulationPrevention(nalUnit);
  const bs = new BitstreamReader(rbsp, 8); // skip NAL header

  const sps = {};
  sps.profile_idc = bs.readBits(8);
  sps.constraint_set0_flag = bs.readBit();
  sps.constraint_set1_flag = bs.readBit();
  sps.constraint_set2_flag = bs.readBit();
  sps.constraint_set3_flag = bs.readBit();
  sps.constraint_set4_flag = bs.readBit();
  sps.constraint_set5_flag = bs.readBit();
  bs.readBits(2); // reserved_zero_2bits
  sps.level_idc = bs.readBits(8);
  sps.seq_parameter_set_id = bs.readUE();

  // High profile extensions
  sps.chroma_format_idc = 1; // default
  sps.separate_colour_plane_flag = 0;
  sps.bit_depth_luma_minus8 = 0;
  sps.bit_depth_chroma_minus8 = 0;
  sps.qpprime_y_zero_transform_bypass_flag = 0;
  sps.seq_scaling_matrix_present_flag = 0;
  sps.scalingLists4x4 = null;
  sps.scalingLists8x8 = null;

  const isHigh = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134].includes(sps.profile_idc);
  if (isHigh) {
    sps.chroma_format_idc = bs.readUE();
    if (sps.chroma_format_idc === 3) {
      sps.separate_colour_plane_flag = bs.readBit();
    }
    sps.bit_depth_luma_minus8 = bs.readUE();
    sps.bit_depth_chroma_minus8 = bs.readUE();
    sps.qpprime_y_zero_transform_bypass_flag = bs.readBit();
    sps.seq_scaling_matrix_present_flag = bs.readBit();

    if (sps.seq_scaling_matrix_present_flag) {
      const numLists = sps.chroma_format_idc !== 3 ? 8 : 12;
      sps.scalingLists4x4 = [];
      sps.scalingLists8x8 = [];
      for (let i = 0; i < numLists; i++) {
        const present = bs.readBit();
        if (present) {
          if (i < 6) {
            sps.scalingLists4x4.push(parseScalingList(bs, 16));
          } else {
            sps.scalingLists8x8.push(parseScalingList(bs, 64));
          }
        } else {
          if (i < 6) sps.scalingLists4x4.push(null);
          else sps.scalingLists8x8.push(null);
        }
      }
    }
  }

  sps.log2_max_frame_num_minus4 = bs.readUE();
  sps.MaxFrameNum = 1 << (sps.log2_max_frame_num_minus4 + 4);

  sps.pic_order_cnt_type = bs.readUE();
  if (sps.pic_order_cnt_type === 0) {
    sps.log2_max_pic_order_cnt_lsb_minus4 = bs.readUE();
    sps.MaxPicOrderCntLsb = 1 << (sps.log2_max_pic_order_cnt_lsb_minus4 + 4);
  } else if (sps.pic_order_cnt_type === 1) {
    sps.delta_pic_order_always_zero_flag = bs.readBit();
    sps.offset_for_non_ref_pic = bs.readSE();
    sps.offset_for_top_to_bottom_field = bs.readSE();
    sps.num_ref_frames_in_pic_order_cnt_cycle = bs.readUE();
    sps.offset_for_ref_frame = [];
    for (let i = 0; i < sps.num_ref_frames_in_pic_order_cnt_cycle; i++) {
      sps.offset_for_ref_frame.push(bs.readSE());
    }
  }

  sps.max_num_ref_frames = bs.readUE();
  sps.gaps_in_frame_num_value_allowed_flag = bs.readBit();

  sps.pic_width_in_mbs_minus1 = bs.readUE();
  sps.pic_height_in_map_units_minus1 = bs.readUE();

  sps.frame_mbs_only_flag = bs.readBit();
  if (!sps.frame_mbs_only_flag) {
    sps.mb_adaptive_frame_field_flag = bs.readBit();
  } else {
    sps.mb_adaptive_frame_field_flag = 0;
  }

  sps.direct_8x8_inference_flag = bs.readBit();

  sps.frame_cropping_flag = bs.readBit();
  sps.frame_crop_left_offset = 0;
  sps.frame_crop_right_offset = 0;
  sps.frame_crop_top_offset = 0;
  sps.frame_crop_bottom_offset = 0;
  if (sps.frame_cropping_flag) {
    sps.frame_crop_left_offset = bs.readUE();
    sps.frame_crop_right_offset = bs.readUE();
    sps.frame_crop_top_offset = bs.readUE();
    sps.frame_crop_bottom_offset = bs.readUE();
  }

  sps.vui_parameters_present_flag = bs.readBit();
  // We skip VUI parsing — not needed for decoding

  // Derived values
  sps.PicWidthInMbs = sps.pic_width_in_mbs_minus1 + 1;
  sps.PicHeightInMapUnits = sps.pic_height_in_map_units_minus1 + 1;
  sps.FrameHeightInMbs = (2 - sps.frame_mbs_only_flag) * sps.PicHeightInMapUnits;
  sps.PicHeightInMbs = sps.FrameHeightInMbs; // frame mode only for now
  sps.PicSizeInMbs = sps.PicWidthInMbs * sps.PicHeightInMbs;

  const cropUnitX = sps.chroma_format_idc === 0 ? 1 : 2;
  const cropUnitY = (sps.chroma_format_idc === 0 ? 1 : 2) * (2 - sps.frame_mbs_only_flag);
  sps.width = sps.PicWidthInMbs * 16 - (sps.frame_crop_left_offset + sps.frame_crop_right_offset) * cropUnitX;
  sps.height = sps.PicHeightInMbs * 16 - (sps.frame_crop_top_offset + sps.frame_crop_bottom_offset) * cropUnitY;

  // ChromaArrayType
  sps.ChromaArrayType = sps.separate_colour_plane_flag ? 0 : sps.chroma_format_idc;
  sps.SubWidthC = sps.chroma_format_idc === 1 || sps.chroma_format_idc === 2 ? 2 : 1;
  sps.SubHeightC = sps.chroma_format_idc === 1 ? 2 : 1;
  sps.MbWidthC = 16 / sps.SubWidthC;
  sps.MbHeightC = 16 / sps.SubHeightC;

  sps.BitDepthY = 8 + sps.bit_depth_luma_minus8;
  sps.BitDepthC = 8 + sps.bit_depth_chroma_minus8;
  sps.QpBdOffsetY = 6 * sps.bit_depth_luma_minus8;
  sps.QpBdOffsetC = 6 * sps.bit_depth_chroma_minus8;

  return sps;
}

function parseScalingList(bs, size) {
  const list = new Int32Array(size);
  let lastScale = 8;
  let nextScale = 8;
  for (let i = 0; i < size; i++) {
    if (nextScale !== 0) {
      const deltaScale = bs.readSE();
      nextScale = (lastScale + deltaScale + 256) % 256;
    }
    list[i] = nextScale === 0 ? lastScale : nextScale;
    lastScale = list[i];
  }
  return list;
}

// ══════════════════════════════════════════════════════════
// PPS Parser
// ══════════════════════════════════════════════════════════

/**
 * Parse a full Picture Parameter Set.
 * @param {Uint8Array} nalUnit - PPS NAL unit data (including NAL header byte)
 * @param {object} sps - The associated SPS (needed for some fields)
 * @returns {object} Parsed PPS fields
 */
export function parsePPSFull(nalUnit, sps) {
  const rbsp = removeEmulationPrevention(nalUnit);
  const bs = new BitstreamReader(rbsp, 8); // skip NAL header

  const pps = {};
  pps.pic_parameter_set_id = bs.readUE();
  pps.seq_parameter_set_id = bs.readUE();
  pps.entropy_coding_mode_flag = bs.readBit(); // 0=CAVLC, 1=CABAC
  pps.bottom_field_pic_order_in_frame_present_flag = bs.readBit();

  pps.num_slice_groups_minus1 = bs.readUE();
  if (pps.num_slice_groups_minus1 > 0) {
    // Slice group map — rarely used, skip for now
    pps.slice_group_map_type = bs.readUE();
    // TODO: parse slice group map if needed
    throw new Error('Slice groups not supported');
  }

  pps.num_ref_idx_l0_default_active_minus1 = bs.readUE();
  pps.num_ref_idx_l1_default_active_minus1 = bs.readUE();
  pps.weighted_pred_flag = bs.readBit();
  pps.weighted_bipred_idc = bs.readBits(2);
  pps.pic_init_qp_minus26 = bs.readSE();
  pps.pic_init_qs_minus26 = bs.readSE();
  pps.chroma_qp_index_offset = bs.readSE();
  pps.deblocking_filter_control_present_flag = bs.readBit();
  pps.constrained_intra_pred_flag = bs.readBit();
  pps.redundant_pic_cnt_present_flag = bs.readBit();

  // High profile extensions
  pps.transform_8x8_mode_flag = 0;
  pps.pic_scaling_matrix_present_flag = 0;
  pps.second_chroma_qp_index_offset = pps.chroma_qp_index_offset;

  if (bs.bitsLeft > 8) {
    // More RBSP data → High profile extensions
    pps.transform_8x8_mode_flag = bs.readBit();
    pps.pic_scaling_matrix_present_flag = bs.readBit();
    if (pps.pic_scaling_matrix_present_flag) {
      const numLists = 6 + (sps?.chroma_format_idc !== 3 ? 2 : 6) * pps.transform_8x8_mode_flag;
      for (let i = 0; i < numLists; i++) {
        const present = bs.readBit();
        if (present) {
          parseScalingList(bs, i < 6 ? 16 : 64);
        }
      }
    }
    pps.second_chroma_qp_index_offset = bs.readSE();
  }

  // Derived
  pps.SliceQPY = 26 + pps.pic_init_qp_minus26;

  return pps;
}

// ══════════════════════════════════════════════════════════
// Slice Header Parser
// ══════════════════════════════════════════════════════════

/**
 * Parse a slice header from a slice NAL unit.
 * @param {Uint8Array} nalUnit - Slice NAL unit (type 1 or 5)
 * @param {object} sps - Active SPS
 * @param {object} pps - Active PPS
 * @returns {object} Parsed slice header + bit position where data begins
 */
export function parseSliceHeader(nalUnit, sps, pps) {
  const rbsp = removeEmulationPrevention(nalUnit);
  const bs = new BitstreamReader(rbsp, 0);

  // NAL header
  const forbidden_zero_bit = bs.readBit();
  const nal_ref_idc = bs.readBits(2);
  const nal_unit_type = bs.readBits(5);

  const sh = {};
  sh.nal_ref_idc = nal_ref_idc;
  sh.nal_unit_type = nal_unit_type;
  sh.isIDR = nal_unit_type === 5;

  sh.first_mb_in_slice = bs.readUE();
  sh.slice_type = bs.readUE();
  // Normalize slice type (0-4 and 5-9 map to the same types)
  sh.slice_type_mod5 = sh.slice_type % 5;
  sh.isI = sh.slice_type_mod5 === 2;
  sh.isP = sh.slice_type_mod5 === 0;
  sh.isB = sh.slice_type_mod5 === 1;

  sh.pic_parameter_set_id = bs.readUE();

  if (sps.separate_colour_plane_flag) {
    sh.colour_plane_id = bs.readBits(2);
  }

  sh.frame_num = bs.readBits(sps.log2_max_frame_num_minus4 + 4);

  sh.field_pic_flag = 0;
  sh.bottom_field_flag = 0;
  if (!sps.frame_mbs_only_flag) {
    sh.field_pic_flag = bs.readBit();
    if (sh.field_pic_flag) {
      sh.bottom_field_flag = bs.readBit();
    }
  }

  if (sh.isIDR) {
    sh.idr_pic_id = bs.readUE();
  }

  sh.pic_order_cnt_lsb = 0;
  sh.delta_pic_order_cnt_bottom = 0;
  sh.delta_pic_order_cnt = [0, 0];

  if (sps.pic_order_cnt_type === 0) {
    sh.pic_order_cnt_lsb = bs.readBits(sps.log2_max_pic_order_cnt_lsb_minus4 + 4);
    if (pps.bottom_field_pic_order_in_frame_present_flag && !sh.field_pic_flag) {
      sh.delta_pic_order_cnt_bottom = bs.readSE();
    }
  } else if (sps.pic_order_cnt_type === 1 && !sps.delta_pic_order_always_zero_flag) {
    sh.delta_pic_order_cnt[0] = bs.readSE();
    if (pps.bottom_field_pic_order_in_frame_present_flag && !sh.field_pic_flag) {
      sh.delta_pic_order_cnt[1] = bs.readSE();
    }
  }

  sh.redundant_pic_cnt = 0;
  if (pps.redundant_pic_cnt_present_flag) {
    sh.redundant_pic_cnt = bs.readUE();
  }

  // P/B slice specific
  sh.direct_spatial_mv_pred_flag = 0;
  sh.num_ref_idx_active_override_flag = 0;
  sh.num_ref_idx_l0_active_minus1 = pps.num_ref_idx_l0_default_active_minus1;
  sh.num_ref_idx_l1_active_minus1 = pps.num_ref_idx_l1_default_active_minus1;

  if (sh.isB) {
    sh.direct_spatial_mv_pred_flag = bs.readBit();
  }

  if (sh.isP || sh.isB) {
    sh.num_ref_idx_active_override_flag = bs.readBit();
    if (sh.num_ref_idx_active_override_flag) {
      sh.num_ref_idx_l0_active_minus1 = bs.readUE();
      if (sh.isB) {
        sh.num_ref_idx_l1_active_minus1 = bs.readUE();
      }
    }
  }

  // Reference picture list modification
  sh.ref_pic_list_modification_l0 = null;
  sh.ref_pic_list_modification_l1 = null;
  if (!sh.isI) {
    // ref_pic_list_modification()
    const l0_flag = bs.readBit();
    if (l0_flag) {
      sh.ref_pic_list_modification_l0 = [];
      while (true) {
        const op = bs.readUE();
        if (op === 3) break;
        const val = bs.readUE();
        sh.ref_pic_list_modification_l0.push({ op, val });
      }
    }
    if (sh.isB) {
      const l1_flag = bs.readBit();
      if (l1_flag) {
        sh.ref_pic_list_modification_l1 = [];
        while (true) {
          const op = bs.readUE();
          if (op === 3) break;
          const val = bs.readUE();
          sh.ref_pic_list_modification_l1.push({ op, val });
        }
      }
    }
  }

  // Weighted prediction
  sh.luma_weight_l0 = null;
  sh.chroma_weight_l0 = null;
  sh.luma_weight_l1 = null;
  sh.chroma_weight_l1 = null;
  if ((pps.weighted_pred_flag && sh.isP) || (pps.weighted_bipred_idc === 1 && sh.isB)) {
    // pred_weight_table()
    sh.luma_log2_weight_denom = bs.readUE();
    if (sps.ChromaArrayType !== 0) {
      sh.chroma_log2_weight_denom = bs.readUE();
    }
    sh.luma_weight_l0 = [];
    sh.chroma_weight_l0 = [];
    for (let i = 0; i <= sh.num_ref_idx_l0_active_minus1; i++) {
      const luma_flag = bs.readBit();
      if (luma_flag) {
        sh.luma_weight_l0.push({ weight: bs.readSE(), offset: bs.readSE() });
      } else {
        sh.luma_weight_l0.push({ weight: 1 << sh.luma_log2_weight_denom, offset: 0 });
      }
      if (sps.ChromaArrayType !== 0) {
        const chroma_flag = bs.readBit();
        if (chroma_flag) {
          sh.chroma_weight_l0.push([
            { weight: bs.readSE(), offset: bs.readSE() },
            { weight: bs.readSE(), offset: bs.readSE() },
          ]);
        } else {
          sh.chroma_weight_l0.push([
            { weight: 1 << sh.chroma_log2_weight_denom, offset: 0 },
            { weight: 1 << sh.chroma_log2_weight_denom, offset: 0 },
          ]);
        }
      }
    }
    if (sh.isB) {
      sh.luma_weight_l1 = [];
      sh.chroma_weight_l1 = [];
      for (let i = 0; i <= sh.num_ref_idx_l1_active_minus1; i++) {
        const luma_flag = bs.readBit();
        if (luma_flag) {
          sh.luma_weight_l1.push({ weight: bs.readSE(), offset: bs.readSE() });
        } else {
          sh.luma_weight_l1.push({ weight: 1 << sh.luma_log2_weight_denom, offset: 0 });
        }
        if (sps.ChromaArrayType !== 0) {
          const chroma_flag = bs.readBit();
          if (chroma_flag) {
            sh.chroma_weight_l1.push([
              { weight: bs.readSE(), offset: bs.readSE() },
              { weight: bs.readSE(), offset: bs.readSE() },
            ]);
          } else {
            sh.chroma_weight_l1.push([
              { weight: 1 << sh.chroma_log2_weight_denom, offset: 0 },
              { weight: 1 << sh.chroma_log2_weight_denom, offset: 0 },
            ]);
          }
        }
      }
    }
  }

  // Decoded reference picture marking
  if (nal_ref_idc !== 0) {
    // dec_ref_pic_marking()
    if (sh.isIDR) {
      sh.no_output_of_prior_pics_flag = bs.readBit();
      sh.long_term_reference_flag = bs.readBit();
    } else {
      sh.adaptive_ref_pic_marking_mode_flag = bs.readBit();
      if (sh.adaptive_ref_pic_marking_mode_flag) {
        sh.mmco = [];
        while (true) {
          const op = bs.readUE();
          if (op === 0) break;
          const entry = { op };
          if (op === 1 || op === 3) entry.difference_of_pic_nums_minus1 = bs.readUE();
          if (op === 2) entry.long_term_pic_num = bs.readUE();
          if (op === 3 || op === 6) entry.long_term_frame_idx = bs.readUE();
          if (op === 4) entry.max_long_term_frame_idx_plus1 = bs.readUE();
          sh.mmco.push(entry);
        }
      }
    }
  }

  // CABAC init
  sh.cabac_init_idc = 0;
  if (pps.entropy_coding_mode_flag && !sh.isI) {
    sh.cabac_init_idc = bs.readUE();
  }

  sh.slice_qp_delta = bs.readSE();
  sh.SliceQPY = 26 + pps.pic_init_qp_minus26 + sh.slice_qp_delta;

  // SP/SI slice specific (rarely used)
  if (sh.slice_type_mod5 === 3 || sh.slice_type_mod5 === 4) {
    if (sh.slice_type_mod5 === 3) {
      sh.sp_for_switch_flag = bs.readBit();
    }
    sh.slice_qs_delta = bs.readSE();
  }

  // Deblocking filter
  sh.disable_deblocking_filter_idc = 0;
  sh.slice_alpha_c0_offset_div2 = 0;
  sh.slice_beta_offset_div2 = 0;
  if (pps.deblocking_filter_control_present_flag) {
    sh.disable_deblocking_filter_idc = bs.readUE();
    if (sh.disable_deblocking_filter_idc !== 1) {
      sh.slice_alpha_c0_offset_div2 = bs.readSE();
      sh.slice_beta_offset_div2 = bs.readSE();
    }
  }

  // Record where slice data begins (for CABAC or CAVLC)
  sh.headerBitLength = bs.bitPos;
  sh._rbsp = rbsp; // keep for CABAC init

  return sh;
}

export default { parseSPSFull, parsePPSFull, parseSliceHeader };
