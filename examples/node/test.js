import { downloadHls } from './src/hls.js';
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';

const url = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

console.log('Testing A/V sync with:', url);
console.log('');

const data = await downloadHls(url, {
  maxSegments: 3,
  quality: 'highest', 
  onProgress: msg => console.log(msg)
});

// Save raw TS for comparison
writeFileSync('./test-input.ts', data);

// Check raw TS audio/video frame counts with ffprobe
console.log('\n=== Source TS info ===');
try {
  const srcInfo = execSync('ffprobe -v error -show_entries stream=codec_type,nb_frames,duration -of default ./test-input.ts 2>&1').toString();
  console.log(srcInfo);
} catch (e) {
  console.log('Could not probe source TS');
}

console.log('\n=== Converting ===\n');

import toMp4 from './src/index.js';
const mp4 = await toMp4(data, { onProgress: msg => console.log(msg) });

writeFileSync('./test-output.mp4', mp4.data);
console.log(`\nWrote ${mp4.sizeFormatted} to ./test-output.mp4`);

// Check result
console.log('\n=== Output MP4 info ===');
const result = execSync('ffprobe -v error -show_entries stream=codec_type,duration,nb_frames -of default ./test-output.mp4').toString();
console.log(result);

