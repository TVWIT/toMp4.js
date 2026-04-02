# H.264 Decoder Implementation Reference

Last updated: 2026-04-01

## Reference Source Code URLs

### FFmpeg H.264 Decoder (LGPL 2.1, libavcodec)
- **CABAC decoding**: https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/h264_cabac.c
- **CABAC engine**: https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/cabac.c
- **CABAC engine header**: https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/cabac.h
- **CABAC inline functions**: https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/cabac_functions.h
- **Macroblock decoding**: https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/h264_mb.c
- **Deblocking filter**: https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/h264_loopfilter.c
- **Direct mode**: https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/h264_direct.c
- **Parameter sets**: https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/h264_ps.c
- **H.264 tables**: https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/h264data.h

### JavaScript H.264 Implementations
- **Broadway.js** (Emscripten/C->WASM, Baseline only, CAVLC only): https://github.com/mbebenita/Broadway
  - Source in `Decoder/src/` - h264bsd_*.c files
  - Key files: h264bsd_cavlc.c, h264bsd_deblocking.c, h264bsd_intra_prediction.c, h264bsd_inter_prediction.c
  - NOTE: No CABAC support (Baseline profile only)
- **prism (de264.js)** (Pure JS, partial): https://github.com/guodong/prism
  - Pure JS, AMD modules, Baseline profile, CAVLC only
  - Files: src/macroblock_layer.js, src/slice.js, src/sps.js, src/pps.js, src/dpb.js
  - Has working CAVLC coefficient decoding with VLC lookup tables
- **FFmpeg H.264 decoder extract**: https://github.com/shengbinmeng/ffmpeg-h264-dec (C, extracted from FFmpeg)

### H.264 Specification (ITU-T H.264 / ISO 14496-10)
- Free draft: https://www.itu.int/rec/T-REC-H.264
- CABAC tables: Sections 9.3.1.1, Tables 9-12 through 9-23


---

## 1. CABAC Engine Implementation

### Core Data Structure
```js
class CABACDecoder {
  constructor(data, offset, length) {
    this.buffer = data;        // Uint8Array
    this.offset = offset;      // current byte position
    this.range = 0x1FE;        // 9-bit range [256..510]
    this.low = 0;              // accumulated value (scaled)
    // Initialize: read first 2 bytes
    this.low = (data[offset] << 10) | (data[offset + 1] << 2) | 2;
    this.offset = offset + 2;
  }
}
```

### Core decode operation (get_cabac)
From FFmpeg cabac_functions.h - the essential CABAC binary arithmetic decode:
```js
decodeBin(ctxState) {
  // ctxState is a Uint8Array element, stores pStateIdx*2 + valMPS packed
  const state = ctxState[0];
  const qRangeIdx = (this.range >> 6) & 3; // 2-bit quantized range index
  const rLPS = LPS_RANGE_TABLE[state >> 1][qRangeIdx];

  this.range -= rLPS;

  if (this.low < (this.range << 10)) {
    // MPS path
    ctxState[0] = MPS_TRANS_TABLE[state]; // state transition for MPS
    this.renormalize();
    return state & 1; // valMPS
  } else {
    // LPS path
    this.low -= this.range << 10;
    this.range = rLPS;
    ctxState[0] = LPS_TRANS_TABLE[state]; // state transition for LPS
    this.renormalize();
    return (state & 1) ^ 1; // 1 - valMPS
  }
}

renormalize() {
  while (this.range < 256) {
    this.range <<= 1;
    this.low <<= 1;
    if (!(this.low & 0xFFFF)) {
      this.low |= (this.buffer[this.offset++] << 9) | (this.buffer[this.offset++] << 1);
      this.low -= 0xFFFF;
    }
  }
}

decodeBypass() {
  this.low <<= 1;
  if (!(this.low & 0xFFFF)) this.refill();
  if (this.low < this.range << 10) return 0;
  this.low -= this.range << 10;
  return 1;
}

decodeTerminate() {
  this.range -= 2;
  if (this.low < this.range << 10) {
    this.renormalize();
    return 0;
  }
  return 1; // end of slice
}
```

### CABAC LPS Range Table (spec Table 9-48)
4 columns for qRangeIdx 0..3, 64 rows for pStateIdx 0..63:
```js
const LPS_RANGE = [
  // pStateIdx: [qRangeIdx 0, 1, 2, 3]
  /* 0*/  [128,176,208,240], /* 1*/  [128,167,197,227],
  /* 2*/  [128,158,187,216], /* 3*/  [123,150,178,205],
  /* 4*/  [116,142,169,195], /* 5*/  [111,135,160,185],
  /* 6*/  [105,128,152,175], /* 7*/  [100,122,144,166],
  /* 8*/  [ 95,116,137,158], /* 9*/  [ 90,110,130,150],
  /*10*/  [ 85,104,123,142], /*11*/  [ 81, 99,117,135],
  /*12*/  [ 77, 94,111,128], /*13*/  [ 73, 89,105,122],
  /*14*/  [ 69, 85,100,116], /*15*/  [ 66, 80, 95,110],
  /*16*/  [ 62, 76, 90,104], /*17*/  [ 59, 72, 86, 99],
  /*18*/  [ 56, 69, 81, 94], /*19*/  [ 53, 65, 77, 89],
  /*20*/  [ 51, 62, 73, 85], /*21*/  [ 48, 59, 69, 80],
  /*22*/  [ 46, 56, 66, 76], /*23*/  [ 43, 53, 63, 72],
  /*24*/  [ 41, 50, 59, 69], /*25*/  [ 39, 48, 56, 65],
  /*26*/  [ 37, 45, 54, 62], /*27*/  [ 35, 43, 51, 59],
  /*28*/  [ 33, 41, 48, 56], /*29*/  [ 32, 39, 46, 53],
  /*30*/  [ 30, 37, 43, 50], /*31*/  [ 29, 35, 41, 48],
  /*32*/  [ 27, 33, 39, 45], /*33*/  [ 26, 31, 37, 43],
  /*34*/  [ 24, 30, 35, 41], /*35*/  [ 23, 28, 33, 39],
  /*36*/  [ 22, 27, 32, 37], /*37*/  [ 21, 26, 30, 35],
  /*38*/  [ 20, 24, 29, 33], /*39*/  [ 19, 23, 27, 31],
  /*40*/  [ 18, 22, 26, 30], /*41*/  [ 17, 21, 25, 28],
  /*42*/  [ 16, 20, 23, 27], /*43*/  [ 15, 19, 22, 25],
  /*44*/  [ 14, 18, 21, 24], /*45*/  [ 14, 17, 20, 23],
  /*46*/  [ 13, 16, 19, 22], /*47*/  [ 12, 15, 18, 21],
  /*48*/  [ 12, 14, 17, 20], /*49*/  [ 11, 14, 16, 19],
  /*50*/  [ 11, 13, 15, 18], /*51*/  [ 10, 12, 15, 17],
  /*52*/  [ 10, 12, 14, 16], /*53*/  [  9, 11, 13, 15],
  /*54*/  [  9, 11, 12, 14], /*55*/  [  8, 10, 12, 14],
  /*56*/  [  8,  9, 11, 13], /*57*/  [  7,  9, 11, 12],
  /*58*/  [  7,  9, 10, 12], /*59*/  [  7,  8, 10, 11],
  /*60*/  [  6,  8,  9, 11], /*61*/  [  6,  7,  9, 10],
  /*62*/  [  6,  7,  8,  9], /*63*/  [  2,  2,  2,  2],
];
```

### CABAC State Transition Tables (spec Table 9-45)
```js
// transIdxMPS[pStateIdx] - next state after MPS
const TRANS_MPS = [
   1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,15,16,
  17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
  33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,
  49,50,51,52,53,54,55,56,57,58,59,60,61,62,62,63
];

// transIdxLPS[pStateIdx] - next state after LPS
const TRANS_LPS = [
   0, 0, 1, 2, 2, 4, 4, 5, 6, 7, 8, 9, 9,11,11,12,
  13,13,15,15,16,16,18,18,19,19,21,21,22,22,23,24,
  24,25,26,26,27,27,28,29,29,30,30,30,31,32,32,33,
  33,33,34,34,35,35,35,36,36,36,37,37,37,38,38,63
];
```

### CABAC Context Initialization
From FFmpeg `ff_h264_init_cabac_states`:
```js
function initCabacContexts(sliceQP, sliceType, cabacInitIdc) {
  const states = new Uint8Array(1024);
  // Choose init table: I-slice vs P/B-slice
  const tab = (sliceType === SLICE_I) ? CABAC_INIT_I : CABAC_INIT_PB[cabacInitIdc];

  for (let i = 0; i < 1024; i++) {
    const m = tab[i][0], n = tab[i][1];
    let preCtxState = Math.max(1, Math.min(126, ((m * sliceQP) >> 4) + n));
    // Pack: pStateIdx = abs(preCtxState - 64), valMPS = (preCtxState >= 64) ? 1 : 0
    if (preCtxState <= 63) {
      states[i] = (63 - preCtxState) << 1; // valMPS = 0
    } else {
      states[i] = ((preCtxState - 64) << 1) | 1; // valMPS = 1
    }
  }
  return states;
}
```

FFmpeg packs this differently. The actual FFmpeg code:
```c
int pre = 2*(((tab[i][0] * slice_qp) >> 4) + tab[i][1]) - 127;
pre ^= pre >> 31;           // abs(pre)
if (pre > 124) pre = 124 + (pre & 1);
state[i] = pre;             // packed: pStateIdx*2 + valMPS
```

---

## 2. CABAC Context Init Tables (m,n pairs)

### Context Index Assignment (where each syntax element lives)
| Syntax Element | Context Indices | Notes |
|---|---|---|
| mb_skip_flag | 11-13 (P), 24-26 (B) | Uses neighbor skip status |
| mb_type (I) | 3-10 | Intra slice: prefix at 3-5, suffix at 5-10 |
| mb_type (P) | 14-17 | |
| mb_type (B) | 27-35 | |
| sub_mb_type (P) | 21-23 | |
| sub_mb_type (B) | 36-39 | |
| mvd_lx[0] | 40-46 | Horizontal MV difference |
| mvd_lx[1] | 47-53 | Vertical MV difference |
| ref_idx | 54-59 | Reference frame index |
| mb_qp_delta | 60-63 | QP delta |
| prev_intra4x4_pred_mode | 68 | |
| rem_intra4x4_pred_mode | 69 | |
| intra_chroma_pred_mode | 64-67 | |
| coded_block_pattern (luma) | 73-76 | |
| coded_block_pattern (chroma) | 77-84 | |
| coded_block_flag | 85-104, 460-483, 1012-1023 | Per-category bases |
| significant_coeff_flag (frame) | 105-165 | |
| significant_coeff_flag (field) | 277-337 | |
| last_significant_coeff_flag (frame) | 166-226 | |
| last_significant_coeff_flag (field) | 338-398 | |
| coeff_abs_level_minus1 | 227-275 | |
| transform_size_8x8_flag | 399-401 | |
| coeff_abs_level_minus1 (8x8, etc.) | 402-459, 952+ | High profile contexts |

### I-slice init table (first 460 contexts, m,n pairs)
Full table from FFmpeg `cabac_context_init_I[1024][2]`:
```js
const CABAC_INIT_I = [
  // 0-10: mb_type I, mb_skip (unused for I)
  [20,-15],[2,54],[3,74],[20,-15],[2,54],[3,74],[-28,127],[-23,104],[-6,53],[-1,54],[7,51],
  // 11-23: mb_skip, mb_type P/B (unused for I, all zero)
  [0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],
  // 24-59: more unused for I
  [0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],
  [0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],
  [0,0],[0,0],[0,0],[0,0],[0,0],[0,0],
  // 60-69: mb_qp_delta, intra_chroma_pred_mode, prev/rem intra4x4
  [0,41],[0,63],[0,63],[0,63],[-9,83],[4,86],[0,97],[-7,72],[13,41],[3,62],
  // 70-87: coded_block_flag bases
  [0,11],[1,55],[0,69],[-17,127],[-13,102],[0,82],[-7,74],[-21,107],
  [-27,127],[-31,127],[-24,127],[-18,95],[-27,127],[-21,114],[-30,127],[-17,123],[-12,115],[-16,122],
  // 88-104: more coded_block_flag
  [-11,115],[-12,63],[-2,68],[-15,84],[-13,104],[-3,70],[-8,93],[-10,90],
  [-30,127],[-1,74],[-6,97],[-7,91],[-20,127],[-4,56],[-5,82],[-7,76],[-22,125],
  // 105-135: significant_coeff_flag (frame, 4x4 luma)
  [-7,93],[-11,87],[-3,77],[-5,71],[-4,63],[-4,68],[-12,84],[-7,62],
  [-7,65],[8,61],[5,56],[-2,66],[1,64],[0,61],[-2,78],[1,50],
  [7,52],[10,35],[0,44],[11,38],[1,45],[0,46],[5,44],[31,17],
  [1,51],[7,50],[28,19],[16,33],[14,62],[-13,108],[-15,100],
  // 136-165: significant_coeff_flag (frame, 4x4 chroma, 8x8)
  [-13,101],[-13,91],[-12,94],[-10,88],[-16,84],[-10,86],[-7,83],[-13,87],
  [-19,94],[1,70],[0,72],[-5,74],[18,59],[-8,102],[-15,100],[0,95],
  [-4,75],[2,72],[-11,75],[-3,71],[15,46],[-13,69],[0,62],[0,65],
  [21,37],[-15,72],[9,57],[16,54],[0,62],[12,72],
  // 166-196: last_significant_coeff_flag (frame)
  [24,0],[15,9],[8,25],[13,18],[15,9],[13,19],[10,37],[12,18],
  [6,29],[20,33],[15,30],[4,45],[1,58],[0,62],[7,61],[12,38],
  [11,45],[15,39],[11,42],[13,44],[16,45],[12,41],[10,49],[30,34],
  [18,42],[10,55],[17,51],[17,46],[0,89],[26,-19],[22,-17],
  // 197-226: last_significant_coeff_flag (frame, cont)
  [26,-17],[30,-25],[28,-20],[33,-23],[37,-27],[33,-23],[40,-28],[38,-17],
  [33,-11],[40,-15],[41,-6],[38,1],[41,17],[30,-6],[27,3],[26,22],
  [37,-16],[35,-4],[38,-8],[38,-3],[37,3],[38,5],[42,0],[35,16],
  [39,22],[14,48],[27,37],[21,60],[12,68],[2,97],
  // 227-251: coeff_abs_level_minus1
  [-3,71],[-6,42],[-5,50],[-3,54],[-2,62],[0,58],[1,63],[-2,72],
  [-1,74],[-9,91],[-5,67],[-5,27],[-3,39],[-2,44],[0,46],[-16,64],
  [-8,68],[-10,78],[-6,77],[-10,86],[-12,92],[-15,55],[-10,60],[-6,62],[-4,65],
  // 252-275: coeff_abs_level_minus1 (cont)
  [-12,73],[-8,76],[-7,80],[-9,88],[-17,110],[-11,97],[-20,84],[-11,79],
  [-6,73],[-4,74],[-13,86],[-13,96],[-11,97],[-19,117],[-8,78],[-5,33],
  [-4,48],[-2,53],[-3,62],[-13,71],[-10,79],[-12,86],[-13,90],[-14,97],
  // 276: bypass (unused)
  [0,0],
  // 277-337: significant_coeff_flag (field)
  [-6,93],[-6,84],[-8,79],[0,66],[-1,71],[0,62],[-2,60],[-2,59],
  [-5,75],[-3,62],[-4,58],[-9,66],[-1,79],[0,71],[3,68],[10,44],
  [-7,62],[15,36],[14,40],[16,27],[12,29],[1,44],[20,36],[18,32],
  [5,42],[1,48],[10,62],[17,46],[9,64],[-12,104],[-11,97],
  [-16,96],[-7,88],[-8,85],[-7,85],[-9,85],[-13,88],[4,66],[-3,77],
  [-3,76],[-6,76],[10,58],[-1,76],[-1,83],[-7,99],[-14,95],[2,95],
  [0,76],[-5,74],[0,70],[-11,75],[1,68],[0,65],[-14,73],[3,62],
  [4,62],[-1,68],[-13,75],[11,55],[5,64],[12,70],
  // 338-398: last_significant_coeff_flag (field) + coeff_abs_level_minus1 (field)
  [15,6],[6,19],[7,16],[12,14],[18,13],[13,11],[13,15],[15,16],
  [12,23],[13,23],[15,20],[14,26],[14,44],[17,40],[17,47],[24,17],
  [21,21],[25,22],[31,27],[22,29],[19,35],[14,50],[10,57],[7,63],
  [-2,77],[-4,82],[-3,94],[9,69],[-12,109],[36,-35],[36,-34],
  [32,-26],[37,-30],[44,-32],[34,-18],[34,-15],[40,-15],[33,-7],[35,-5],
  [33,0],[38,2],[33,13],[23,35],[13,58],[29,-3],[26,0],[22,30],
  [31,-7],[35,-15],[34,-3],[34,3],[36,-1],[34,5],[32,11],[35,5],
  [34,12],[39,11],[30,29],[34,26],[29,39],[19,66],
  // 399-401: transform_size_8x8_flag
  [31,21],[31,31],[25,50],
  // 402-435: High Profile 8x8 contexts
  [-17,120],[-20,112],[-18,114],[-11,85],[-15,92],[-14,89],[-26,71],[-15,81],
  [-14,80],[0,68],[-14,70],[-24,56],[-23,68],[-24,50],[-11,74],[23,-13],
  [26,-13],[40,-15],[49,-14],[44,3],[45,6],[44,34],[33,54],[19,82],
  [-3,75],[-1,23],[1,34],[1,43],[0,54],[-2,55],[0,61],[1,64],[0,68],[-9,92],
  // 436-459: High Profile level contexts
  [-14,106],[-13,97],[-15,90],[-12,90],[-18,88],[-10,73],[-9,79],[-14,86],
  [-10,73],[-10,70],[-10,69],[-5,66],[-9,64],[-5,58],[2,59],[21,-10],
  [24,-11],[28,-8],[28,-1],[29,3],[29,9],[35,20],[29,36],[14,67],
];
```

### P/B-slice init table (cabac_init_idc=0, first 460 contexts)
```js
const CABAC_INIT_PB_0 = [
  // 0-10
  [20,-15],[2,54],[3,74],[20,-15],[2,54],[3,74],[-28,127],[-23,104],[-6,53],[-1,54],[7,51],
  // 11-23: mb_skip P, mb_type P
  [23,33],[23,2],[21,0],[1,9],[0,49],[-37,118],[5,57],[-13,78],[-11,65],[1,62],[12,49],[-4,73],[17,50],
  // 24-39: mb_type B, sub_mb_type
  [18,64],[9,43],[29,0],[26,67],[16,90],[9,104],[-46,127],[-20,104],[1,67],[-13,78],[-11,65],[1,62],[-6,86],[-17,95],[-6,61],[9,45],
  // 40-53: mvd_lx[0], mvd_lx[1]
  [-3,69],[-6,81],[-11,96],[6,55],[7,67],[-5,86],[2,88],[0,58],[-3,76],[-10,94],[5,54],[4,69],[-3,81],[0,88],
  // 54-59: ref_idx
  [-7,67],[-5,74],[-4,74],[-5,80],[-7,72],[1,58],
  // 60-69: mb_qp_delta, chroma_pred_mode, intra4x4_pred_mode
  [0,41],[0,63],[0,63],[0,63],[-9,83],[4,86],[0,97],[-7,72],[13,41],[3,62],
  // 70-104: coded_block_flag
  [0,45],[-4,78],[-3,96],[-27,126],[-28,98],[-25,101],[-23,67],[-28,82],
  [-20,94],[-16,83],[-22,110],[-21,91],[-18,102],[-13,93],[-29,127],[-7,92],
  [-5,89],[-7,96],[-13,108],[-3,46],[-1,65],[-1,57],[-9,93],[-3,74],
  [-9,92],[-8,87],[-23,126],[5,54],[6,60],[6,59],[6,69],[-1,48],[0,68],[-4,69],[-8,88],
  // 105-165: significant_coeff_flag + last_significant_coeff (frame)
  [-2,85],[-6,78],[-1,75],[-7,77],[2,54],[5,50],[-3,68],[1,50],
  [6,42],[-4,81],[1,63],[-4,70],[0,67],[2,57],[-2,76],[11,35],
  [4,64],[1,61],[11,35],[18,25],[12,24],[13,29],[13,36],[-10,93],
  [-7,73],[-2,73],[13,46],[9,49],[-7,100],[9,53],[2,53],[5,53],
  [-2,61],[0,56],[0,56],[-13,63],[-5,60],[-1,62],[4,57],[-6,69],
  [4,57],[14,39],[4,51],[13,68],[3,64],[1,61],[9,63],[7,50],
  [16,39],[5,44],[4,52],[11,48],[-5,60],[-1,59],[0,59],[22,33],
  [5,44],[14,43],[-1,78],[0,60],[9,69],
  // 166-226: last_significant_coeff_flag (frame) + coeff_abs_level_minus1
  [11,28],[2,40],[3,44],[0,49],[0,46],[2,44],[2,51],[0,47],
  [4,39],[2,62],[6,46],[0,54],[3,54],[2,58],[4,63],[6,51],
  [6,57],[7,53],[6,52],[6,55],[11,45],[14,36],[8,53],[-1,82],
  [7,55],[-3,78],[15,46],[22,31],[-1,84],[25,7],[30,-7],[28,3],
  [28,4],[32,0],[34,-1],[30,6],[30,6],[32,9],[31,19],[26,27],
  [26,30],[37,20],[28,34],[17,70],[1,67],[5,59],[9,67],[16,30],
  [18,32],[18,35],[22,29],[24,31],[23,38],[18,43],[20,41],[11,63],
  [9,59],[9,64],[-1,94],[-2,89],[-9,108],
  // 227-275: coeff_abs_level_minus1
  [-6,76],[-2,44],[0,45],[0,52],[-3,64],[-2,59],[-4,70],[-4,75],
  [-8,82],[-17,102],[-9,77],[3,24],[0,42],[0,48],[0,55],[-6,59],
  [-7,71],[-12,83],[-11,87],[-30,119],[1,58],[-3,29],[-1,36],[1,38],
  [2,43],[-6,55],[0,58],[0,64],[-3,74],[-10,90],[0,70],[-4,29],
  [5,31],[7,42],[1,59],[-2,58],[-3,72],[-3,81],[-11,97],[0,58],
  [8,5],[10,14],[14,18],[13,27],[2,40],[0,58],[-3,70],[-6,79],[-8,85],
  // 276: bypass
  [0,0],
  // 277-337: coded_block_flag (field) + significant_coeff_flag (field)
  [-13,106],[-16,106],[-10,87],[-21,114],[-18,110],[-14,98],[-22,110],[-21,106],
  [-18,103],[-21,107],[-23,108],[-26,112],[-10,96],[-12,95],[-5,91],[-9,93],
  [-22,94],[-5,86],[9,67],[-4,80],[-10,85],[-1,70],[7,60],[9,58],
  [5,61],[12,50],[15,50],[18,49],[17,54],[10,41],[7,46],[-1,51],
  [7,49],[8,52],[9,41],[6,47],[2,55],[13,41],[10,44],[6,50],
  [5,53],[13,49],[4,63],[6,64],[-2,69],[-2,59],[6,70],[10,44],
  [9,31],[12,43],[3,53],[14,34],[10,38],[-3,52],[13,40],[17,32],
  [7,44],[7,38],[13,50],[10,57],[26,43],
  // 338-398: last_significant_coeff_flag (field)
  [14,11],[11,14],[9,11],[18,11],[21,9],[23,-2],[32,-15],[32,-15],
  [34,-21],[39,-23],[42,-33],[41,-31],[46,-28],[38,-12],[21,29],[45,-24],
  [53,-45],[48,-26],[65,-43],[43,-19],[39,-10],[30,9],[18,26],[20,27],
  [0,57],[-14,82],[-5,75],[-19,97],[-35,125],[27,0],[28,0],[31,-4],
  [27,6],[34,8],[30,10],[24,22],[33,19],[22,32],[26,31],[21,41],
  [26,44],[23,47],[16,65],[14,71],[8,60],[6,63],[17,65],[21,24],
  [23,20],[26,23],[27,32],[28,23],[28,24],[23,40],[24,32],[28,29],
  [23,42],[19,57],[22,53],[22,61],[11,86],
  // 399-401: transform_size_8x8_flag
  [12,40],[11,51],[14,59],
  // 402-435: High profile
  [-4,79],[-7,71],[-5,69],[-9,70],[-8,66],[-10,68],[-19,73],[-12,69],
  [-16,70],[-15,67],[-20,62],[-19,70],[-16,66],[-22,65],[-20,63],[9,-2],
  [26,-9],[33,-9],[39,-7],[41,-2],[45,3],[49,9],[45,27],[36,59],
  [-6,66],[-7,35],[-7,42],[-8,45],[-5,48],[-12,56],[-6,60],[-5,62],[-8,66],[-8,76],
  // 436-459
  [-5,85],[-6,81],[-10,77],[-7,81],[-17,80],[-18,73],[-4,74],[-10,83],
  [-9,71],[-9,67],[-1,61],[-8,66],[-14,66],[0,59],[2,59],[21,-13],
  [33,-14],[39,-7],[46,-2],[51,2],[60,6],[61,17],[55,34],[42,62],
];
```

Note: cabac_init_idc=1 and cabac_init_idc=2 tables follow the same structure.
Full tables are in FFmpeg h264_cabac.c `cabac_context_init_PB[3][1024][2]`.


---

## 3. CABAC Binarization Rules

### mb_type (I-slice) - Context indices 3-10
```
if (ctxIdxInc from neighbors) == 0 -> I_4x4
  1 + terminate -> I_PCM
  1 + 0 + ... -> I_16x16 subtypes
    bit at ctx[state+1]: cbp_luma!=0 (0 or 12 added)
    bit at ctx[state+2]: cbp_chroma>0
      if yes: bit at ctx[state+2+1]: cbp_chroma==2
      adds 4 or 8
    bits at ctx[state+3+1], ctx[state+3+2]: pred_mode (0-3)
```

From FFmpeg `decode_cabac_intra_mb_type`:
```c
// For I-slice (intra_slice=1):
ctx = 0;
if (left_type & (INTRA16x16|INTRA_PCM)) ctx++;
if (top_type  & (INTRA16x16|INTRA_PCM)) ctx++;
if (get_cabac(state[ctx]) == 0) return 0;  // I_4x4
if (get_cabac_terminate()) return 25;       // I_PCM
mb_type = 1;
mb_type += 12 * get_cabac(state[1]);       // cbp_luma != 0
if (get_cabac(state[2]))                    // cbp_chroma > 0
  mb_type += 4 + 4 * get_cabac(state[3]);  // cbp_chroma == 2
mb_type += 2 * get_cabac(state[4]);         // pred_mode bit 1
mb_type += 1 * get_cabac(state[5]);         // pred_mode bit 0
return mb_type; // 1..24 maps to I_16x16 subtypes
```

### mb_type (P-slice) - Context indices 14-17
```
0    -> ctx14=0: P_L0_16x16 or P_8x8
        ctx15=0: check ctx16 -> 0=P_L0_16x16, 1=P_8x8
        ctx15=1: ctx17 -> 0=P_L0_16x8, 1=P_L0_8x16
1xxx -> intra (reuse I-slice decode at ctx_base=17)
```

From FFmpeg:
```c
if (get_cabac(state[14]) == 0) {
  if (get_cabac(state[15]) == 0)
    mb_type = 3 * get_cabac(state[16]); // 0=P_L0_16x16, 3=P_8x8
  else
    mb_type = 2 - get_cabac(state[17]); // 1=P_L0_16x8, 2=P_L0_8x16
} else {
  mb_type = decode_cabac_intra_mb_type(sl, 17, 0); // intra in P-slice
}
```

### mb_type (B-slice) - Context indices 27-35
```
ctx[27+ctxInc]=0 -> B_Direct_16x16
ctx[27+ctxInc]=1:
  ctx[27+3]=0 -> 1 + ctx[27+5] (B_L0_16x16 or B_L1_16x16)
  ctx[27+3]=1:
    read 4 bits from ctx[27+4], ctx[27+5], ctx[27+5], ctx[27+5]
    maps to B_Bi_16x16 through B_8x8, or intra
```

### sub_mb_type (P-slice) - Context indices 21-23
```c
if (get_cabac(state[21])) return 0;  // 8x8
if (!get_cabac(state[22])) return 1; // 8x4
if (get_cabac(state[23])) return 2;  // 4x8
return 3;                             // 4x4
```

### sub_mb_type (B-slice) - Context indices 36-39
```c
if (!get_cabac(state[36])) return 0;          // B_Direct_8x8
if (!get_cabac(state[37]))
  return 1 + get_cabac(state[39]);            // B_L0_8x8 or B_L1_8x8
type = 3;
if (get_cabac(state[38])) {
  if (get_cabac(state[39]))
    return 11 + get_cabac(state[39]);         // B_L1_4x4 or B_Bi_4x4
  type += 4;
}
type += 2 * get_cabac(state[39]);
type += get_cabac(state[39]);
return type;                                   // 3..10
```

### coded_block_pattern (luma) - Context indices 73-76
4 bins, each conditioned on left/top CBP:
```c
ctx = !(cbp_a & 0x02) + 2 * !(cbp_b & 0x04);  // for bit 0
cbp += get_cabac(state[73 + ctx]);
ctx = !(cbp & 0x01)   + 2 * !(cbp_b & 0x08);  // for bit 1
cbp += get_cabac(state[73 + ctx]) << 1;
ctx = !(cbp_a & 0x08) + 2 * !(cbp & 0x01);    // for bit 2
cbp += get_cabac(state[73 + ctx]) << 2;
ctx = !(cbp & 0x04)   + 2 * !(cbp & 0x02);    // for bit 3
cbp += get_cabac(state[73 + ctx]) << 3;
```

### coded_block_pattern (chroma) - Context indices 77-84
```c
ctx = (cbp_a_chroma > 0) + 2*(cbp_b_chroma > 0);
if (get_cabac(state[77 + ctx]) == 0) return 0;
ctx = 4 + (cbp_a_chroma == 2) + 2*(cbp_b_chroma == 2);
return 1 + get_cabac(state[77 + ctx]);
```

### mvd (motion vector difference) - Context indices 40-46 (horiz), 47-53 (vert)
Uses UEG (Unary/Exp-Golomb) binarization:
```c
// amvd = |mvd_left| + |mvd_top| (sum of absolute neighbor MVDs)
ctx = ctxbase + (amvd > 2) + (amvd > 32) + 2; // actually: ((amvd-3)>>31) + ((amvd-33)>>31) + 2
// Prefix: unary up to 9 with contexts ctxbase+3..ctxbase+6
if (!get_cabac(state[ctx])) { mvd = 0; return 0; }
mvd = 1;
ctx = ctxbase + 3;
while (mvd < 9 && get_cabac(state[ctx])) {
  if (mvd < 4) ctx++;
  mvd++;
}
// Suffix: Exp-Golomb k=3 coded with bypass bins
if (mvd >= 9) {
  int k = 3;
  while (get_cabac_bypass()) { mvd += 1 << k; k++; }
  while (k--) { mvd += get_cabac_bypass() << k; }
}
// Sign: bypass bin
sign = get_cabac_bypass();
return sign ? -mvd : mvd;
```

### coded_block_flag - Context bases per category
```js
const CBF_CTX_BASE = {
  0:   85, // DC 16x16 luma
  1:   89, // AC 16x16 luma
  2:   93, // Luma 4x4
  3:   97, // DC chroma
  4:  101, // AC chroma
  5: 1012, // Luma 8x8
  6:  460, // (High profile additions...)
  7:  464,
  8:  468,
  9: 1016,
  10: 472,
  11: 476,
  12: 480,
  13: 1020,
};
// ctx = base + (nz_left > 0) + 2*(nz_top > 0)
```

### significant_coeff_flag / last_significant_coeff_flag
Context offsets per category (frame MB / field MB):
```js
const SIG_COEFF_OFFSET = {
  frame: [105, 120, 134, 149, 152, 402, 484, 499, 513, 660, 528, 543, 557, 718],
  field: [277, 292, 306, 321, 324, 436, 776, 791, 805, 675, 820, 835, 849, 733]
};
const LAST_COEFF_OFFSET = {
  frame: [166, 181, 195, 210, 213, 417, 572, 587, 601, 690, 616, 631, 645, 748],
  field: [338, 353, 367, 382, 385, 451, 864, 879, 893, 699, 908, 923, 937, 757]
};
```

For 4x4 blocks: ctx = base + scan_position (0..14)
For 8x8 blocks: ctx = base + offset_table[scan_position] (non-linear mapping)

8x8 significant_coeff_flag context offset (frame):
```js
const SIG_COEFF_8x8_FRAME = [
  0,1,2,3,4,5,5,4,4,3,3,4,4,4,5,5,
  4,4,4,4,3,3,6,7,7,7,8,9,10,9,8,7,
  7,6,11,12,13,11,6,7,8,9,14,10,9,8,6,11,
  12,13,11,6,9,14,10,9,11,12,13,11,14,10,12
];
```

### coeff_abs_level_minus1 - Context indices 227+
Uses unary + Exp-Golomb k=0 (bypass):
```c
// Node-based context selection (state machine)
const coeff_abs_level1_ctx = [1,2,3,4,0,0,0,0]; // for |level|==1
const coeff_abs_levelgt1_ctx = [5,5,5,5,6,7,8,9]; // for |level|>1
const transition_on_1 = [1,2,3,3,4,5,6,7];
const transition_on_gt1 = [4,4,4,4,5,6,7,7];

node_ctx = 0;
for each coefficient (reverse scan order):
  ctx = abs_level_m1_base + coeff_abs_level1_ctx[node_ctx];
  if (get_cabac(ctx) == 0) {
    level = 1;
    node_ctx = transition_on_1[node_ctx];
  } else {
    ctx = abs_level_m1_base + coeff_abs_levelgt1_ctx[node_ctx];
    node_ctx = transition_on_gt1[node_ctx];
    level = 2;
    while (level < 15 && get_cabac(ctx)) level++;
    if (level >= 15) {
      // Exp-Golomb k=0 suffix with bypass bins
      k = 0;
      while (get_cabac_bypass()) { level += 1 << k; k++; }
      while (k--) level += get_cabac_bypass() << k;
      level += 14;
    }
  }
  sign = get_cabac_bypass(); // 0=positive, 1=negative
```


---

## 4. Deblocking Filter

### Filter tables (from FFmpeg h264_loopfilter.c)
```js
// Alpha threshold table, indexed by QP + slice_alpha_c0_offset (clamped to 0..51)
const ALPHA_TABLE = [
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,4,4,5,6,7,8,9,10,12,13,15,17,20,22,
  25,28,32,36,40,45,50,56,63,71,80,90,101,113,127,144,162,182,203,226,255,255,
];
// Beta threshold table
const BETA_TABLE = [
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,2,2,2,3,3,3,3,4,4,4,6,6,7,7,
  8,8,9,9,10,10,11,11,12,12,13,13,14,14,15,15,16,16,17,17,18,18,
];
// tc0 table, indexed by [QP + alpha_offset][bS], bS=0..3
// bS=0: always -1 (no filter), bS=1..3: see table
const TC0_TABLE = [
  // QP 0..51, each row: [bS=0, bS=1, bS=2, bS=3]
  [-1,0,0,0], /*...repeated for QP 0-15...*/ [-1,0,0,0],
  [-1,0,0,1], [-1,0,0,1], [-1,0,0,1], [-1,0,0,1],
  [-1,0,1,1], [-1,0,1,1], [-1,1,1,1], [-1,1,1,1],
  [-1,1,1,1], [-1,1,1,1], [-1,1,1,2], [-1,1,1,2],
  [-1,1,1,2], [-1,1,1,2], [-1,1,2,3], [-1,1,2,3],
  [-1,2,2,3], [-1,2,2,4], [-1,2,3,4], [-1,2,3,4],
  [-1,3,3,5], [-1,3,4,6], [-1,3,4,6], [-1,4,5,7],
  [-1,4,5,8], [-1,4,6,9], [-1,5,7,10],[-1,6,8,11],
  [-1,6,8,13],[-1,7,10,14],[-1,8,11,16],[-1,9,12,18],
  [-1,10,13,20],[-1,11,15,23],[-1,13,17,25],
];
```

### Boundary Strength (bS) calculation
```
bS = 4: either p or q is intra, AND it's a macroblock edge
bS = 3: either p or q is intra (internal edge)
bS = 2: either p or q has coded coefficients
bS = 1: different reference frames, or |mvdiff| >= 4
bS = 0: no filtering
```

### Filter operation (luma, bS < 4)
```js
function filterLuma(p, q, alpha, beta, tc0) {
  // p[0..2]: pixels on P side (p[0] nearest boundary)
  // q[0..2]: pixels on Q side
  if (Math.abs(p[0] - q[0]) >= alpha) return;
  if (Math.abs(p[1] - p[0]) >= beta) return;
  if (Math.abs(q[1] - q[0]) >= beta) return;

  let tc = tc0;
  let ap = Math.abs(p[2] - p[0]);
  let aq = Math.abs(q[2] - q[0]);
  if (ap < beta) tc++;
  if (aq < beta) tc++;

  let delta = Math.max(-tc, Math.min(tc,
    ((((q[0] - p[0]) << 2) + (p[1] - q[1]) + 4) >> 3)));
  p[0] = clip(p[0] + delta, 0, 255);
  q[0] = clip(q[0] - delta, 0, 255);

  if (ap < beta) {
    p[1] += Math.max(-tc0, Math.min(tc0,
      (p[2] + ((p[0] + q[0] + 1) >> 1) - 2*p[1]) >> 1));
  }
  if (aq < beta) {
    q[1] += Math.max(-tc0, Math.min(tc0,
      (q[2] + ((p[0] + q[0] + 1) >> 1) - 2*q[1]) >> 1));
  }
}
```

### Filter operation (luma, bS == 4, intra edge)
```js
function filterLumaIntra(p, q, alpha, beta) {
  if (Math.abs(p[0] - q[0]) >= alpha) return;
  if (Math.abs(p[1] - p[0]) >= beta) return;
  if (Math.abs(q[1] - q[0]) >= beta) return;

  if (Math.abs(p[0] - q[0]) < ((alpha >> 2) + 2)) {
    // Strong filtering
    if (Math.abs(p[2] - p[0]) < beta) {
      p[0] = (p[2] + 2*p[1] + 2*p[0] + 2*q[0] + q[1] + 4) >> 3;
      p[1] = (p[2] + p[1] + p[0] + q[0] + 2) >> 2;
      p[2] = (2*p[3] + 3*p[2] + p[1] + p[0] + q[0] + 4) >> 3;
    } else {
      p[0] = (2*p[1] + p[0] + q[1] + 2) >> 2;
    }
    // Same for q side...
  } else {
    // Weak filtering (same as bS<4 with tc=1)
    p[0] = (2*p[1] + p[0] + q[1] + 2) >> 2;
    q[0] = (2*q[1] + q[0] + p[1] + 2) >> 2;
  }
}
```


---

## 5. Motion Compensation

### Quarter-pel interpolation (6-tap Wiener filter)
Luma uses a 6-tap filter for half-pel, then bilinear for quarter-pel:
```js
// Half-pel filter coefficients: [1, -5, 20, 20, -5, 1] / 32 (with rounding)
function halfPel(A, B, C, D, E, F) {
  return clip((A - 5*B + 20*C + 20*D - 5*E + F + 16) >> 5, 0, 255);
}
```

Quarter-pel positions are averages of adjacent full/half-pel positions.

### Chroma interpolation (bilinear, 1/8 pel)
```js
function chromaInterp(src, xFrac, yFrac, stride) {
  // xFrac, yFrac are 1/8 pel offsets (0..7)
  return ((8-xFrac)*(8-yFrac)*src[0] + xFrac*(8-yFrac)*src[1] +
          (8-xFrac)*yFrac*src[stride] + xFrac*yFrac*src[stride+1] + 32) >> 6;
}
```

### Motion vector prediction (median)
```js
function predMV(mvA, mvB, mvC) {
  // A=left, B=top, C=top-right (or top-left if unavailable)
  // Median prediction for 16x16, 16x8, 8x16 has special cases
  if (!availA && !availB && !availC) return [0, 0];
  if (availA && !availB && !availC) return mvA;
  // General: median of three
  return [median(mvA[0], mvB[0], mvC[0]), median(mvA[1], mvB[1], mvC[1])];
}
```


---

## 6. Intra Prediction Modes

### 4x4 Luma (9 modes)
```
Mode 0: Vertical       - copy top row down
Mode 1: Horizontal     - copy left column right
Mode 2: DC             - average of top + left
Mode 3: Diagonal Down-Left
Mode 4: Diagonal Down-Right
Mode 5: Vertical-Right
Mode 6: Horizontal-Down
Mode 7: Vertical-Left
Mode 8: Horizontal-Up
```

### 16x16 Luma (4 modes)
```
Mode 0: Vertical    - replicate top 16 pixels
Mode 1: Horizontal  - replicate left 16 pixels
Mode 2: DC          - average of top 16 + left 16
Mode 3: Plane       - linear gradient
```

### 8x8 Chroma (4 modes, same as 16x16 but reordered)
```
Mode 0: DC
Mode 1: Horizontal
Mode 2: Vertical
Mode 3: Plane
```

### Intra 4x4 pred_mode CABAC decoding
```c
// prev_intra4x4_pred_mode_flag at context 68
// rem_intra4x4_pred_mode at context 69 (3 bypass-like bins)
if (get_cabac(state[68])) return pred_mode; // use predicted mode
mode  = get_cabac(state[69]);
mode += get_cabac(state[69]) << 1;
mode += get_cabac(state[69]) << 2;
return mode + (mode >= pred_mode); // skip predicted mode in enumeration
```


---

## 7. Scaling/Quantization

### Default scaling matrices (from h264_ps.c)
```js
const DEFAULT_SCALING_4x4_INTRA = [
   6,13,20,28,13,20,28,32,20,28,32,37,28,32,37,42
];
const DEFAULT_SCALING_4x4_INTER = [
  10,14,20,24,14,20,24,27,20,24,27,30,24,27,30,34
];
const DEFAULT_SCALING_8x8_INTRA = [
   6,10,13,16,18,23,25,27,10,11,16,18,23,25,27,29,
  13,16,18,23,25,27,29,31,16,18,23,25,27,29,31,33,
  18,23,25,27,29,31,33,36,23,25,27,29,31,33,36,38,
  25,27,29,31,33,36,38,40,27,29,31,33,36,38,40,42
];
```

### Inverse quantization
```js
// For 4x4 transform:
// level[i] = (coeffLevel[i] * dequantScale[qp%6][i] * (1 << (qp/6))) >> 4
// For DC (Intra16x16): additional Hadamard inverse transform
```


---

## 8. Scan Orders

### Zigzag scan (4x4)
```js
const ZIGZAG_4x4 = [0,1,4,8,5,2,3,6,9,12,13,10,7,11,14,15];
```

### Zigzag scan (8x8)
```js
const ZIGZAG_8x8 = [
   0, 1, 8,16, 9, 2, 3,10,17,24,32,25,18,11, 4, 5,
  12,19,26,33,40,48,41,34,27,20,13, 6, 7,14,21,28,
  35,42,49,56,57,50,43,36,29,22,15,23,30,37,44,51,
  58,59,52,45,38,31,39,46,53,60,61,54,47,55,62,63
];
```

### scan8 (macroblock cache index mapping, from FFmpeg)
Maps 4x4 block index to position in 8-wide cache arrays:
```js
const SCAN8 = [
  4+ 1*8, 5+ 1*8, 4+ 2*8, 5+ 2*8, // blocks 0-3 (top-left 8x8)
  6+ 1*8, 7+ 1*8, 6+ 2*8, 7+ 2*8, // blocks 4-7 (top-right 8x8)
  4+ 3*8, 5+ 3*8, 4+ 4*8, 5+ 4*8, // blocks 8-11 (bottom-left 8x8)
  6+ 3*8, 7+ 3*8, 6+ 4*8, 7+ 4*8, // blocks 12-15 (bottom-right 8x8)
  // 16-19: Cb 4x4, 20-23: Cr 4x4, 24-25: Cb/Cr DC
];
```


---

## 9. Key Implementation Notes

### FFmpeg's packed CABAC state
FFmpeg packs `pStateIdx` and `valMPS` into a single byte: `state = pStateIdx * 2 + valMPS`.
The transition tables in `ff_h264_cabac_tables` operate on this packed representation.
The `ff_h264_mlps_state` table (at offset 1024 in `ff_h264_cabac_tables`) encodes both
MPS and LPS transitions in 256 entries (128 for MPS result, 128 for LPS result).

### Broadway.js limitations
- Baseline profile only (no CABAC, no B-frames, no 8x8 transform)
- Compiled from C to JavaScript/WASM via Emscripten
- Not useful as a JS reference for CABAC implementation
- Good reference for CAVLC, intra prediction, and deblocking in C

### prism/de264.js
- Pure JavaScript, AMD modules
- Implements Baseline profile subset
- Uses CAVLC with hardcoded VLC lookup tables
- Has working implementations of:
  - SPS/PPS parsing
  - Slice header parsing
  - Macroblock layer with CAVLC coefficient decoding
  - POC (picture order count) calculation
  - DPB (decoded picture buffer)
  - YUV to RGB conversion for canvas rendering
- No CABAC, no B-frames, no interlacing

### Performance considerations for JS
- Use TypedArrays (Uint8Array for state, Int16Array for coefficients)
- The CABAC engine's inner loop (get_cabac) is the hottest path
- Consider using a single packed state byte (like FFmpeg) to minimize memory access
- Pre-compute the LPS range table as a flat array indexed by `(range_quantized << 7) | state`
- Batch bypass bin reads for MVD suffix and coefficient sign/level
