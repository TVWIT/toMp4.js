import toMp4 from '../../src/index.js';
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';

const url = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

console.log('=== Basic conversion ===\n');

const mp4 = await toMp4(url, {
  maxSegments: 3,
  quality: 'highest', 
  onProgress: msg => console.log(msg)
});

writeFileSync('./test-output.mp4', mp4.data);
console.log(`\nWrote ${mp4.sizeFormatted} to ./test-output.mp4`);

// Check result with ffprobe if available
console.log('\n=== Output MP4 info ===');
try {
  const result = execSync('ffprobe -v error -show_entries stream=codec_type,duration,nb_frames -of default ./test-output.mp4').toString();
  console.log(result);
} catch (e) {
  console.log('ffprobe not available, skipping verification');
}

console.log('=== One-step HLS clip (0-10s) ===\n');

const clipped = await toMp4(url, {
  quality: 'highest',
  startTime: 0,
  endTime: 10,
  onProgress: msg => console.log(msg)
});

writeFileSync('./test-clipped.mp4', clipped.data);
console.log(`\nWrote ${clipped.sizeFormatted} to ./test-clipped.mp4`);

console.log('\n=== Analyze ===\n');

// Download some data to analyze
const { downloadHls } = await import('../../src/hls.js');
const data = await downloadHls(url, { maxSegments: 5 });
const info = toMp4.analyze(data);

console.log('Duration:', info.duration.toFixed(2), 'seconds');
console.log('Video frames:', info.videoFrames);
console.log('Keyframes:', info.keyframeCount);
console.log('Video codec:', info.videoCodec);
console.log('Audio codec:', info.audioCodec);

console.log('\n✓ Done');
