/**
 * MPEG-1/2 Audio Layer III (MP3) encoder — pure JavaScript, from scratch.
 *
 * Implements the ISO/IEC 11172-3 Layer III CBR encoder: polyphase analysis
 * filterbank + long-block MDCT (dsp.js), then per-granule quantization to the
 * bitrate budget, Huffman coding, and bitstream formatting. Long blocks only
 * and no psychoacoustic model / scalefactors (a compact CBR design, correct and
 * transparent for speech/broadcast) — the reservoir is disabled, so each frame
 * is self-contained (main_data_begin = 0).
 *
 * API mirrors the common JS convention:
 *   const enc = new Mp3Encoder(channels, sampleRate, kbps);
 *   const buf = enc.encodeBuffer(int16Mono)  // or (left, right)
 *   const end = enc.flush();
 */
import { HUFFMAN, SFB_INDEX, SLEN1_TAB, SLEN2_TAB, SAMPLE_RATES, BITRATE_TABLE } from './tables.js';
import { newSubbandState, windowFilterSubband, mdctGranule, invertOddBands } from './dsp.js';

const GRANULE = 576;
const MAX_CHANNELS = 2;

// ── bit writer (MSB-first) ───────────────────────────────────────────────────
class BitWriter {
  constructor() { this.buf = []; this.cache = 0; this.n = 0; this.total = 0; }
  put(val, bits) {
    for (let i = bits - 1; i >= 0; i--) {
      this.cache = (this.cache << 1) | ((val >>> i) & 1);
      if (++this.n === 8) { this.buf.push(this.cache & 0xff); this.cache = 0; this.n = 0; }
    }
    this.total += bits;
  }
  count() { return this.total; }
  takeBytes() { const b = Uint8Array.from(this.buf); this.buf = []; return b; }
}

// ── quantization: ix[i] = round( (|xr|·2^(-stepsize/4))^0.75 − 0.0946 ) ───────
function quantize(xrabs, xrmax, stepsize, ix) {
  const scale = Math.pow(2, -stepsize / 4);
  if (Math.pow(xrmax * scale, 0.75) > 8192) return 16384; // stepsize too small
  let max = 0;
  for (let i = 0; i < GRANULE; i++) {
    const t = xrabs[i] * scale;
    let v = t <= 0 ? 0 : Math.floor(Math.pow(t, 0.75) - 0.0946 + 0.5);
    if (v < 0) v = 0;
    ix[i] = v;
    if (v > max) max = v;
  }
  return max;
}

function ixMax(ix, begin, end) { let m = 0; for (let i = begin; i < end; i++) if (ix[i] > m) m = ix[i]; return m; }

// rzero / count1 / big_values partition
function calcRunlen(ix, gi) {
  let i = GRANULE;
  for (; i > 1; i -= 2) { if (ix[i - 1] || ix[i - 2]) break; }
  gi.count1 = 0;
  for (; i > 3; i -= 4) {
    if (ix[i - 1] <= 1 && ix[i - 2] <= 1 && ix[i - 3] <= 1 && ix[i - 4] <= 1) gi.count1++;
    else break;
  }
  gi.big_values = i >> 1;
}

function count1Bitcount(ix, gi) {
  let sum0 = 0, sum1 = 0;
  for (let i = gi.big_values << 1, k = 0; k < gi.count1; i += 4, k++) {
    const v = ix[i], w = ix[i + 1], x = ix[i + 2], y = ix[i + 3];
    const p = v + (w << 1) + (x << 2) + (y << 3);
    let sb = 0; if (v) sb++; if (w) sb++; if (x) sb++; if (y) sb++;
    sum0 += sb + HUFFMAN[32].hlen[p];
    sum1 += sb + HUFFMAN[33].hlen[p];
  }
  if (sum0 < sum1) { gi.count1table_select = 0; return sum0; }
  gi.count1table_select = 1; return sum1;
}

const SUBDV = [[0,0],[0,0],[0,0],[0,0],[0,0],[0,1],[1,1],[1,1],[1,2],[2,2],[2,3],[2,3],
  [3,4],[3,4],[3,4],[4,5],[4,5],[4,6],[5,6],[5,6],[5,7],[6,7],[6,7]];

function subdivide(gi, sfb) {
  if (!gi.big_values) { gi.region0_count = 0; gi.region1_count = 0; gi.address1 = 0; gi.address2 = 0; gi.address3 = 0; return; }
  const bv = 2 * gi.big_values;
  let anz = 0; while (sfb[anz] < bv) anz++;
  let tc;
  for (tc = SUBDV[anz][0]; tc; tc--) if (sfb[tc + 1] <= bv) break;
  gi.region0_count = tc;
  gi.address1 = sfb[tc + 1];
  const off = gi.region0_count + 1;
  for (tc = SUBDV[anz][1]; tc; tc--) if (sfb[off + tc + 1] <= bv) break;
  gi.region1_count = tc;
  gi.address2 = sfb[off + tc + 1];
  gi.address3 = bv;
}

function countBit(ix, start, end, table) {
  if (!table) return 0;
  const h = HUFFMAN[table]; const ylen = h.ylen, linbits = h.linbits;
  let sum = 0;
  if (table > 15) {
    for (let i = start; i < end; i += 2) {
      let x = ix[i], y = ix[i + 1];
      if (x > 14) { x = 15; sum += linbits; }
      if (y > 14) { y = 15; sum += linbits; }
      sum += h.hlen[x * ylen + y];
      if (x) sum++; if (y) sum++;
    }
  } else {
    for (let i = start; i < end; i += 2) {
      const x = ix[i], y = ix[i + 1];
      sum += h.hlen[x * ylen + y];
      if (x) sum++; if (y) sum++;
    }
  }
  return sum;
}

function chooseTable(ix, begin, end) {
  let max = ixMax(ix, begin, end);
  if (!max) return 0;
  let c0 = 0;
  if (max < 15) {
    // smallest no-linbits table whose range covers `max`
    for (let i = 1; i < 15; i++) if (HUFFMAN[i].xlen > max) { c0 = i; break; }
    let s0 = countBit(ix, begin, end, c0), s1;
    switch (c0) {
      case 2: s1 = countBit(ix, begin, end, 3); if (s1 <= s0) c0 = 3; break;
      case 5: s1 = countBit(ix, begin, end, 6); if (s1 <= s0) c0 = 6; break;
      case 7: s1 = countBit(ix, begin, end, 8); if (s1 <= s0) { c0 = 8; s0 = s1; }
              s1 = countBit(ix, begin, end, 9); if (s1 <= s0) c0 = 9; break;
      case 10: s1 = countBit(ix, begin, end, 11); if (s1 <= s0) { c0 = 11; s0 = s1; }
               s1 = countBit(ix, begin, end, 12); if (s1 <= s0) c0 = 12; break;
      case 13: s1 = countBit(ix, begin, end, 15); if (s1 <= s0) c0 = 15; break;
    }
  } else {
    max -= 15;
    let c1 = 0;
    for (let i = 15; i < 24; i++) if (HUFFMAN[i].linmax >= max) { c0 = i; break; }
    for (let i = 24; i < 32; i++) if (HUFFMAN[i].linmax >= max) { c1 = i; break; }
    const s0 = countBit(ix, begin, end, c0), s1 = countBit(ix, begin, end, c1);
    if (s1 < s0) c0 = c1;
  }
  return c0;
}

function bigvTabSelect(ix, gi) {
  gi.table_select[0] = gi.table_select[1] = gi.table_select[2] = 0;
  if (gi.address1 > 0) gi.table_select[0] = chooseTable(ix, 0, gi.address1);
  if (gi.address2 > gi.address1) gi.table_select[1] = chooseTable(ix, gi.address1, gi.address2);
  if (gi.big_values << 1 > gi.address2) gi.table_select[2] = chooseTable(ix, gi.address2, gi.big_values << 1);
}

function bigvBitcount(ix, gi) {
  let bits = 0;
  if (gi.table_select[0]) bits += countBit(ix, 0, gi.address1, gi.table_select[0]);
  if (gi.table_select[1]) bits += countBit(ix, gi.address1, gi.address2, gi.table_select[1]);
  if (gi.table_select[2]) bits += countBit(ix, gi.address2, gi.big_values << 1, gi.table_select[2]);
  return bits;
}

export class Mp3Encoder {
  constructor(channels, sampleRate, kbps) {
    const srIndex = SAMPLE_RATES.indexOf(sampleRate);
    if (srIndex < 0) throw new Error(`MP3: unsupported sample rate ${sampleRate}`);
    const version = srIndex < 3 ? 3 : srIndex < 6 ? 2 : 0; // MPEG-1 / 2 / 2.5
    const brIndex = BITRATE_TABLE.findIndex((r) => r[version] === kbps);
    if (brIndex < 0) throw new Error(`MP3: unsupported bitrate ${kbps} for ${sampleRate}Hz`);
    if (channels !== 1 && channels !== 2) throw new Error('MP3: channels must be 1 or 2');

    this.channels = channels;
    this.sampleRate = sampleRate;
    this.version = version;                 // 3=MPEG-1, 2=MPEG-2, 0=MPEG-2.5
    this.srIndex = srIndex;
    this.brIndex = brIndex;
    this.kbps = kbps;
    this.granules = version === 3 ? 2 : 1;
    this.mode = channels === 2 ? 0 : 3;     // 0=stereo, 3=mono
    this.sfb = SFB_INDEX[srIndex];

    // framing
    const slots = (this.granules * GRANULE / sampleRate) * (1000 * kbps / 8);
    this.wholeSlots = Math.floor(slots);
    this.fracSlots = slots - this.wholeSlots;
    this.slotLag = -this.fracSlots;
    this.sideInfoLen = 8 * (this.granules === 2
      ? (channels === 1 ? 21 : 36)          // MPEG-1: 4+17 / 4+32 bytes
      : (channels === 1 ? 13 : 21));        // MPEG-2: 4+9 / 4+17 bytes

    // per-channel filterbank + subband-sample history [granules+1][18][32]
    this.subState = [];
    this.sb = [];
    for (let ch = 0; ch < MAX_CHANNELS; ch++) {
      this.subState.push(newSubbandState());
      const blocks = [];
      for (let g = 0; g <= this.granules; g++) {
        const rows = [];
        for (let k = 0; k < 18; k++) rows.push(new Float64Array(32));
        blocks.push(rows);
      }
      this.sb.push(blocks);
    }
    // mdct output + quantized values, per channel/granule
    this.xr = []; this.ix = [];
    for (let ch = 0; ch < MAX_CHANNELS; ch++) {
      this.xr.push([]); this.ix.push([]);
      for (let g = 0; g < this.granules; g++) {
        this.xr[ch].push(new Float64Array(GRANULE));
        this.ix[ch].push(new Int32Array(GRANULE));
      }
    }
    this.scfsi = [[0,0,0,0],[0,0,0,0]];

    // pending input PCM per channel (Float64), consumed a frame at a time
    this.frameSamples = this.granules * GRANULE;
    this.pending = [[], []];
  }

  _newGrInfo() {
    return { part2_3_length: 0, big_values: 0, count1: 0, global_gain: 0,
      scalefac_compress: 0, table_select: [0,0,0], region0_count: 0, region1_count: 0,
      address1: 0, address2: 0, address3: 0, count1table_select: 0, quantizerStepSize: 0 };
  }

  // succesive-approximation initial step size
  _binSearchStep(ix, desired, gi) {
    let next = -120, count = 120;
    do {
      const half = count >> 1;
      let bit;
      const g = this;
      if (quantize(g._xrabs, g._xrmax, next + half, ix) > 8192) bit = 100000;
      else { calcRunlen(ix, gi); bit = count1Bitcount(ix, gi); subdivide(gi, this.sfb); bigvTabSelect(ix, gi); bit += bigvBitcount(ix, gi); }
      if (bit < desired) count = half; else { next += half; count -= half; }
    } while (count > 1);
    return next;
  }

  _innerLoop(ix, maxBits, gi) {
    let bits;
    if (maxBits < 0) gi.quantizerStepSize--;
    do {
      while (quantize(this._xrabs, this._xrmax, ++gi.quantizerStepSize, ix) > 8192) { /* shrink */ }
      calcRunlen(ix, gi);
      bits = count1Bitcount(ix, gi);
      subdivide(gi, this.sfb);
      bigvTabSelect(ix, gi);
      bits += bigvBitcount(ix, gi);
    } while (bits > maxBits);
    return bits;
  }

  _quantizeGranule(xr, ix, maxBits, gi) {
    // precompute |xr|, max
    this._xrabs = new Float64Array(GRANULE);
    let xrmax = 0;
    for (let i = 0; i < GRANULE; i++) { const a = Math.abs(xr[i]); this._xrabs[i] = a; if (a > xrmax) xrmax = a; }
    this._xrmax = xrmax;
    if (xrmax === 0) { ix.fill(0); gi.big_values = 0; gi.count1 = 0; gi.part2_3_length = 0; gi.global_gain = 210; return; }
    // no scalefactors → part2_length = 0
    gi.quantizerStepSize = this._binSearchStep(ix, maxBits, gi);
    const bits = this._innerLoop(ix, maxBits, gi);
    gi.part2_3_length = bits;
    gi.global_gain = gi.quantizerStepSize + 210;
  }

  // ── one frame ──────────────────────────────────────────────────────────────
  _encodeFrame(out) {
    const g = this;
    // padding for fractional slots (44.1k etc.)
    let padding = 0;
    if (g.fracSlots) { padding = (g.slotLag <= g.fracSlots - 1.0) ? 1 : 0; g.slotLag += padding - g.fracSlots; }
    const bitsPerFrame = 8 * (g.wholeSlots + padding);
    const meanBits = Math.floor((bitsPerFrame - g.sideInfoLen) / g.granules);
    g._padding = padding;

    // polyphase + MDCT
    for (let ch = 0; ch < g.channels; ch++) {
      let pos = 0;
      const pcm = g._framePcm[ch];
      for (let gr = 0; gr < g.granules; gr++) {
        const cur = g.sb[ch][gr + 1];
        for (let k = 0; k < 18; k++) {
          windowFilterSubband(g.subState[ch], pcm, pos, cur[k]);
          pos += 32;
          if (k & 1) invertOddBands(cur[k]);
        }
        mdctGranule(g.sb[ch][gr], g.sb[ch][gr + 1], g.xr[ch][gr]);
      }
      // carry last granule to slot 0 for next frame's overlap
      const last = g.sb[ch][g.granules];
      for (let k = 0; k < 18; k++) g.sb[ch][0][k].set(last[k]);
    }

    // quantize each granule/channel
    const gr_info = [];
    for (let gr = 0; gr < g.granules; gr++) { gr_info.push([]); for (let ch = 0; ch < g.channels; ch++) gr_info[gr].push(g._newGrInfo()); }
    let resvSize = 0;
    for (let ch = 0; ch < g.channels; ch++) {
      for (let gr = 0; gr < g.granules; gr++) {
        const gi = gr_info[gr][ch];
        const maxBits = Math.min(4095, meanBits >> (g.channels - 1)); // meanBits/channels
        g._quantizeGranule(g.xr[ch][gr], g.ix[ch][gr], maxBits, gi);
        resvSize += (meanBits >> (g.channels - 1)) - gi.part2_3_length;
      }
    }
    // fold xr sign onto the quantized magnitudes (Huffman coder reads it back)
    for (let ch = 0; ch < g.channels; ch++)
      for (let gr = 0; gr < g.granules; gr++) {
        const xr = g.xr[ch][gr], ix = g.ix[ch][gr];
        for (let i = 0; i < GRANULE; i++) if (xr[i] < 0 && ix[i] > 0) ix[i] = -ix[i];
      }
    // frame stuffing (reservoir disabled): drain slack into gr0/ch0, keep byte aligned
    if (g.channels === 2 && (meanBits & 1)) resvSize += 1;
    let stuffing = resvSize;
    if (stuffing) {
      const gi0 = gr_info[0][0];
      if (gi0.part2_3_length + stuffing < 4095) gi0.part2_3_length += stuffing;
      else {
        for (let gr = 0; gr < g.granules && stuffing; gr++)
          for (let ch = 0; ch < g.channels && stuffing; ch++) {
            const gi = gr_info[gr][ch];
            const extra = Math.min(4095 - gi.part2_3_length, stuffing);
            gi.part2_3_length += extra; stuffing -= extra;
          }
      }
    }

    g._writeFrame(out, gr_info, padding);
  }

  _writeFrame(bs, gr_info, padding) {
    const g = this;
    // header (32 bits)
    bs.put(0x7ff, 11);
    bs.put(g.version, 2);
    bs.put(1, 2);              // layer III = 01
    bs.put(1, 1);              // protection bit (no CRC) = 1
    bs.put(g.brIndex, 4);
    bs.put(g.srIndex % 3, 2);
    bs.put(padding, 1);
    bs.put(0, 1);              // private
    bs.put(g.mode, 2);
    bs.put(0, 2);              // mode_ext
    bs.put(0, 1);              // copyright
    bs.put(1, 1);              // original
    bs.put(0, 2);              // emphasis
    // side info
    if (g.version === 3) { bs.put(0, 9); bs.put(0, g.channels === 2 ? 3 : 5); }
    else { bs.put(0, 8); bs.put(0, g.channels === 2 ? 2 : 1); }
    if (g.version === 3) for (let ch = 0; ch < g.channels; ch++) for (let b = 0; b < 4; b++) bs.put(g.scfsi[ch][b], 1);
    for (let gr = 0; gr < g.granules; gr++)
      for (let ch = 0; ch < g.channels; ch++) {
        const gi = gr_info[gr][ch];
        bs.put(gi.part2_3_length, 12);
        bs.put(gi.big_values, 9);
        bs.put(gi.global_gain, 8);
        bs.put(gi.scalefac_compress, g.version === 3 ? 4 : 9);
        bs.put(0, 1);          // window_switching_flag = 0 (long blocks)
        for (let r = 0; r < 3; r++) bs.put(gi.table_select[r], 5);
        bs.put(gi.region0_count, 4);
        bs.put(gi.region1_count, 3);
        if (g.version === 3) bs.put(0, 1); // preflag
        bs.put(0, 1);          // scalefac_scale
        bs.put(gi.count1table_select, 1);
      }
    // main data
    for (let gr = 0; gr < g.granules; gr++)
      for (let ch = 0; ch < g.channels; ch++) {
        const gi = gr_info[gr][ch];
        // scalefactors are all zero (slen1=slen2=0) → nothing to write
        g._huffmanCodeBits(bs, g.ix[ch][gr], gi);
      }
  }

  _huffmanCodeBits(bs, ix, gi) {
    const g = this;
    // restore sign onto quantized magnitudes from xr sign (done via a sign-carrying copy)
    const start = bs.count();
    const bigvalues = gi.big_values << 1;
    const scalefac = g.sfb;
    let idx = gi.region0_count + 1;
    const region1Start = scalefac[idx];
    idx += gi.region1_count + 1;
    const region2Start = scalefac[idx];

    for (let i = 0; i < bigvalues; i += 2) {
      const tbl = gi.table_select[(i >= region1Start ? 1 : 0) + (i >= region2Start ? 1 : 0)];
      if (tbl) huffmanCode(bs, tbl, ix[i], ix[i + 1]);
    }
    // count1 region
    const h = HUFFMAN[gi.count1table_select + 32];
    const c1end = bigvalues + (gi.count1 << 2);
    for (let i = bigvalues; i < c1end; i += 4) huffmanCount1(bs, h, ix[i], ix[i + 1], ix[i + 2], ix[i + 3]);
    // stuffing to part2_3_length
    let bits = bs.count() - start;
    bits = gi.part2_3_length - bits; // part2_length is 0
    while (bits >= 32) { bs.put(0xffffffff >>> 0, 32); bits -= 32; }
    if (bits > 0) bs.put(2 ** bits - 1, bits);
  }

  /**
   * @param {Int16Array} left  - mono samples, or left channel
   * @param {Int16Array} [right] - right channel (stereo only)
   * @returns {Uint8Array} MP3 bytes for the frames completed by this input
   */
  encodeBuffer(left, right) {
    const g = this;
    const chData = g.channels === 2 ? [left, right] : [left];
    for (let ch = 0; ch < g.channels; ch++) {
      const p = g.pending[ch], d = chData[ch];
      for (let i = 0; i < d.length; i++) p.push(d[i] / 32768); // normalize to [-1,1)
    }
    const bs = new BitWriter();
    while (g.pending[0].length >= g.frameSamples) {
      g._framePcm = [];
      for (let ch = 0; ch < g.channels; ch++) g._framePcm.push(g.pending[ch].splice(0, g.frameSamples));
      g._encodeFrame(bs);
    }
    return bs.takeBytes();
  }

  flush() {
    const g = this;
    const bs = new BitWriter();
    // pad the tail with zeros to complete a final frame if anything is pending
    if (g.pending[0].length > 0) {
      for (let ch = 0; ch < g.channels; ch++) while (g.pending[ch].length < g.frameSamples) g.pending[ch].push(0);
      g._framePcm = [];
      for (let ch = 0; ch < g.channels; ch++) g._framePcm.push(g.pending[ch].splice(0, g.frameSamples));
      g._encodeFrame(bs);
    }
    return bs.takeBytes();
  }
}

// Apply xr sign to quantized magnitude just before Huffman coding.
function huffmanCode(bs, table, x, y) {
  let signx = 0, signy = 0;
  if (x < 0) { signx = 1; x = -x; }
  if (y < 0) { signy = 1; y = -y; }
  const h = HUFFMAN[table]; const ylen = h.ylen;
  if (table > 15) {
    const linbits = h.linbits;
    let lx = 0, ly = 0;
    if (x > 14) { lx = x - 15; x = 15; }
    if (y > 14) { ly = y - 15; y = 15; }
    const i = x * ylen + y;
    bs.put(h.table[i], h.hlen[i]);
    let ext = 0, xbits = 0;
    if (x === 15) { ext = lx; xbits += linbits; }
    if (x !== 0) { ext = (ext << 1) | signx; xbits += 1; }
    if (y === 15) { ext = (ext * Math.pow(2, linbits)) + ly; xbits += linbits; }
    if (y !== 0) { ext = (ext << 1) | signy; xbits += 1; }
    if (xbits) bs.put(ext, xbits);
  } else {
    const i = x * ylen + y;
    let code = h.table[i], cbits = h.hlen[i];
    if (x !== 0) { code = (code << 1) | signx; cbits += 1; }
    if (y !== 0) { code = (code << 1) | signy; cbits += 1; }
    bs.put(code, cbits);
  }
}

function huffmanCount1(bs, h, v, w, x, y) {
  let sv = 0, sw = 0, sx = 0, sy = 0;
  if (v < 0) { sv = 1; v = -v; } if (w < 0) { sw = 1; w = -w; }
  if (x < 0) { sx = 1; x = -x; } if (y < 0) { sy = 1; y = -y; }
  const p = v + (w << 1) + (x << 2) + (y << 3);
  bs.put(h.table[p], h.hlen[p]);
  let code = 0, cbits = 0;
  if (v) { code = sv; cbits = 1; }
  if (w) { code = (code << 1) | sw; cbits++; }
  if (x) { code = (code << 1) | sx; cbits++; }
  if (y) { code = (code << 1) | sy; cbits++; }
  if (cbits) bs.put(code, cbits);
}
