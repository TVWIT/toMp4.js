#!/usr/bin/env node
/**
 * Simple bundler that combines all modules into a single UMD file
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Get version from package.json
const pkg = JSON.parse(readFileSync(`${__dirname}/package.json`, 'utf-8'));
const version = pkg.version;

const tsToMp4 = readFileSync(`${__dirname}/src/ts-to-mp4.js`, 'utf-8')
  .replace(/export (function|default)/g, '$1')
  .replace(/^export /gm, '');

const fmp4ToMp4 = readFileSync(`${__dirname}/src/fmp4-to-mp4.js`, 'utf-8')
  .replace(/export (function|default)/g, '$1')
  .replace(/^export /gm, '');

const bundle = `/**
 * toMp4.js v${version}
 * Convert MPEG-TS and fMP4 to standard MP4
 * https://github.com/TVWIT/toMp4.js
 * MIT License
 */
(function(global, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define(factory);
  } else {
    global = global || self;
    global.toMp4 = factory();
  }
})(this, function() {
  'use strict';

  // ============================================
  // MPEG-TS to MP4 Converter
  // ============================================
  ${tsToMp4.replace(/^/gm, '  ').trim()}

  // ============================================
  // fMP4 to MP4 Converter  
  // ============================================
  ${fmp4ToMp4.replace(/^/gm, '  ').trim()}

  // ============================================
  // Main API
  // ============================================
  function isMpegTs(data) {
    if (data.length < 4) return false;
    if (data[0] === 0x47) return true;
    for (var i = 0; i < Math.min(188, data.length); i++) {
      if (data[i] === 0x47 && i + 188 < data.length && data[i + 188] === 0x47) return true;
    }
    return false;
  }

  function isFmp4(data) {
    if (data.length < 8) return false;
    var type = String.fromCharCode(data[4], data[5], data[6], data[7]);
    return type === 'ftyp' || type === 'styp' || type === 'moof';
  }

  function isStandardMp4(data) {
    if (data.length < 12) return false;
    var type = String.fromCharCode(data[4], data[5], data[6], data[7]);
    if (type !== 'ftyp') return false;
    var offset = 0;
    var view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    var hasMoov = false, hasMoof = false;
    while (offset + 8 <= data.length) {
      var size = view.getUint32(offset);
      if (size < 8) break;
      var boxType = String.fromCharCode(data[offset+4], data[offset+5], data[offset+6], data[offset+7]);
      if (boxType === 'moov') hasMoov = true;
      if (boxType === 'moof') hasMoof = true;
      offset += size;
    }
    return hasMoov && !hasMoof;
  }

  function detectFormat(data) {
    if (isMpegTs(data)) return 'mpegts';
    if (isStandardMp4(data)) return 'mp4';
    if (isFmp4(data)) return 'fmp4';
    return 'unknown';
  }

  function toMp4(data) {
    var uint8 = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    var format = detectFormat(uint8);
    switch (format) {
      case 'mpegts': return convertTsToMp4(uint8);
      case 'fmp4': return convertFmp4ToMp4(uint8);
      case 'mp4': return uint8;
      default: throw new Error('Unrecognized video format. Expected MPEG-TS or fMP4.');
    }
  }

  toMp4.fromTs = convertTsToMp4;
  toMp4.fromFmp4 = convertFmp4ToMp4;
  toMp4.detectFormat = detectFormat;
  toMp4.isMpegTs = isMpegTs;
  toMp4.isFmp4 = isFmp4;
  toMp4.isStandardMp4 = isStandardMp4;
  toMp4.version = '${version}';

  return toMp4;
});
`;

try {
  mkdirSync(`${__dirname}/dist`, { recursive: true });
} catch (e) {}

writeFileSync(`${__dirname}/dist/tomp4.js`, bundle);

// Also update version in src/index.js
let indexJs = readFileSync(`${__dirname}/src/index.js`, 'utf-8');
indexJs = indexJs.replace(/toMp4\.version = '[^']*'/, `toMp4.version = '${version}'`);
writeFileSync(`${__dirname}/src/index.js`, indexJs);

console.log(`Built dist/tomp4.js (v${version})`);

