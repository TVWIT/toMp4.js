/**
 * MP3 front-end DSP: polyphase analysis filterbank + MDCT (long blocks).
 *
 * Implements the ISO/IEC 11172-3 analysis filterbank and the Layer III long-
 * block MDCT with the Table B.9 aliasing-reduction butterfly. Floating point.
 * Like most compact CBR encoders, we use long blocks exclusively (block_type 0)
 * — correct and transparent for speech/broadcast material; it removes all
 * window-switching state.
 */
import { ENWINDOW } from './tables.js';

const SBLIMIT = 32;
const HAN_SIZE = 512;
const PI = Math.PI;

// Analysis filter matrix M[i][j] = cos((2i+1)(16-j)π/64), rounded to the ISO
// document's 9-decimal accuracy (matches the reference filterbank tables).
const FILTER = [];
for (let i = 0; i < SBLIMIT; i++) {
  const row = new Float64Array(64);
  for (let j = 0; j < 64; j++) {
    row[j] = Math.round(1e9 * Math.cos(((2 * i + 1) * (16 - j) * PI) / 64)) / 1e9;
  }
  FILTER.push(row);
}

// Combined MDCT + window coefficients: cos_l[m][k] =
//   sin(π/36·(k+0.5)) · cos(π/72·(2k+19)(2m+1)),  m∈0..17, k∈0..35
const COS_L = [];
for (let m = 0; m < 18; m++) {
  const row = new Float64Array(36);
  for (let k = 0; k < 36; k++) {
    row[k] = Math.sin((PI / 36) * (k + 0.5)) * Math.cos((PI / 72) * (2 * k + 19) * (2 * m + 1));
  }
  COS_L.push(row);
}

// Analysis→synthesis round-trip gain normalization. Our floating-point pipeline
// runs without the reference's fixed-point down-shifts, so the MDCT round trip
// carries an N/2-style gain; this scales it back to unity (calibrated so a full-
// scale sine reconstructs at full scale, verified against a decoder).
const MDCT_SCALE = 1 / 9; // N/2 for N=18

// Table B.9 aliasing butterfly coefficients.
const ALIAS_C = [-0.6, -0.535, -0.33, -0.185, -0.095, -0.041, -0.0142, -0.0037];
const CS = ALIAS_C.map((c) => 1.0 / Math.sqrt(1.0 + c * c));
const CA = ALIAS_C.map((c) => c / Math.sqrt(1.0 + c * c));

/** Per-channel filterbank state: 512-sample ring buffer + write offset. */
export function newSubbandState() {
  return { x: new Float64Array(HAN_SIZE), off: 0 };
}

/**
 * Window + filter 32 new PCM samples into 32 subband samples.
 * @param {object} st - per-channel subband state
 * @param {Float64Array|Array} pcm - normalized input samples ([-1,1])
 * @param {number} pos - index of the first of 32 samples to consume
 * @param {Float64Array} out - length-32 output subband samples
 */
export function windowFilterSubband(st, pcm, pos, out) {
  const { x } = st;
  let off = st.off;
  // newest sample goes to x[off+0], oldest to x[off+31] (reverse fill), matching
  // the ISO analysis buffer ordering — otherwise each block is time-reversed
  // relative to the window and the bands mis-map.
  for (let i = 0; i < 32; i++) x[i + off] = pcm[pos + 31 - i];

  const y = new Float64Array(64);
  for (let i = 0; i < 64; i++) {
    let s = 0;
    for (let k = 0; k < 8; k++) {
      s += x[(off + i + (k << 6)) & (HAN_SIZE - 1)] * ENWINDOW[i + (k << 6)];
    }
    y[i] = s;
  }
  st.off = (off + 480) & (HAN_SIZE - 1);

  for (let i = 0; i < SBLIMIT; i++) {
    const f = FILTER[i];
    let s = 0;
    for (let j = 0; j < 64; j++) s += f[j] * y[j];
    out[i] = s;
  }
}

/**
 * Compute the MDCT frequency lines for one granule/channel.
 *
 * @param {Float64Array[]} sbPrev - previous granule's 18 subband-sample rows [18][32]
 * @param {Float64Array[]} sbCur  - current granule's 18 subband-sample rows [18][32]
 * @param {Float64Array} freqOut  - length-576 output, laid out as [band*18 + k]
 */
export function mdctGranule(sbPrev, sbCur, freqOut) {
  const mdctIn = new Float64Array(36);
  // freqOut viewed as [32][18]
  for (let band = 0; band < 32; band++) {
    for (let k = 0; k < 18; k++) {
      mdctIn[k] = sbPrev[k][band];
      mdctIn[k + 18] = sbCur[k][band];
    }
    for (let k = 0; k < 18; k++) {
      const c = COS_L[k];
      let vm = 0;
      for (let j = 0; j < 36; j++) vm += mdctIn[j] * c[j];
      freqOut[band * 18 + k] = vm * MDCT_SCALE;
    }
    // aliasing reduction butterfly against the previous band
    if (band !== 0) {
      for (let i = 0; i < 8; i++) {
        const a = freqOut[band * 18 + i];
        const b = freqOut[(band - 1) * 18 + (17 - i)];
        freqOut[band * 18 + i] = a * CS[i] - b * CA[i];
        freqOut[(band - 1) * 18 + (17 - i)] = b * CS[i] + a * CA[i];
      }
    }
  }
}

/** Frequency inversion for odd (band,k) — applied to current subband samples
 *  before MDCT, compensating the analysis-filter sign (Shine does this on
 *  l3_sb_sample[k+1][band] for odd band). */
export function invertOddBands(sbRow) {
  for (let band = 1; band < 32; band += 2) sbRow[band] = -sbRow[band];
}

export { SBLIMIT, HAN_SIZE };
