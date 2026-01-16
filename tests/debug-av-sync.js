/**
 * Debug A/V sync - check timing alignment between tracks
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';

// Check original fMP4 timing
console.log('=== Original fMP4 Timing ===\n');

const result = execSync(
    'ffprobe -v error -show_entries stream=codec_type,start_time,start_pts,time_base -of json tests/fmp4-samples/combined.mp4',
    { encoding: 'utf8' }
);
console.log('Original streams:');
const orig = JSON.parse(result);
for (const s of orig.streams) {
    console.log(`  ${s.codec_type}: start_time=${s.start_time}s, start_pts=${s.start_pts}, time_base=${s.time_base}`);
}

// Check converted output timing
console.log('\n=== Converted Output Timing ===\n');

const result2 = execSync(
    'ffprobe -v error -show_entries stream=codec_type,start_time,start_pts,time_base -of json tests/output/combined-output.mp4',
    { encoding: 'utf8' }
);
console.log('Converted streams:');
const conv = JSON.parse(result2);
for (const s of conv.streams) {
    console.log(`  ${s.codec_type}: start_time=${s.start_time}s, start_pts=${s.start_pts}, time_base=${s.time_base}`);
}

// Check for delay differences
console.log('\n=== A/V Sync Analysis ===\n');

const origVideo = orig.streams.find(s => s.codec_type === 'video');
const origAudio = orig.streams.find(s => s.codec_type === 'audio');
const convVideo = conv.streams.find(s => s.codec_type === 'video');
const convAudio = conv.streams.find(s => s.codec_type === 'audio');

if (origVideo && origAudio) {
    const origDiff = parseFloat(origVideo.start_time) - parseFloat(origAudio.start_time);
    console.log(`Original A/V start diff: ${(origDiff * 1000).toFixed(2)}ms`);
}

if (convVideo && convAudio) {
    const convDiff = parseFloat(convVideo.start_time) - parseFloat(convAudio.start_time);
    console.log(`Converted A/V start diff: ${(convDiff * 1000).toFixed(2)}ms`);
}
