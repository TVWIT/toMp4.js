import { downloadHls, analyzeTsData } from '../../src/index.js';
import toMp4 from '../../src/index.js';
import { writeFileSync } from 'fs';

const url = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

console.log('Downloading test stream...\n');

const data = await downloadHls(url, {
  maxSegments: 10,
  quality: 'highest', 
  onProgress: msg => console.log(msg)
});

console.log('\n=== Analyzing ===\n');

const analysis = analyzeTsData(data);
console.log('Duration:', analysis.duration.toFixed(2), 'seconds');
console.log('Video frames:', analysis.videoFrames);
console.log('Audio frames:', analysis.audioFrames);
console.log('Keyframes:', analysis.keyframeCount);
console.log('Keyframe times:', analysis.keyframes.map(k => k.time.toFixed(2) + 's').join(', '));
console.log('Video codec:', analysis.videoCodec);
console.log('Audio codec:', analysis.audioCodec);

console.log('\n=== Converting full video ===\n');

const fullMp4 = await toMp4(data, { onProgress: msg => console.log(msg) });
writeFileSync('./test-full.mp4', fullMp4.data);
console.log(`Full: ${fullMp4.sizeFormatted}`);

console.log('\n=== Clipping 5-15 seconds ===\n');

const clippedMp4 = await toMp4(data, { 
  startTime: 5,
  endTime: 15,
  onProgress: msg => console.log(msg) 
});
writeFileSync('./test-clipped.mp4', clippedMp4.data);
console.log(`Clipped: ${clippedMp4.sizeFormatted}`);

console.log('\n✓ Done! Check test-full.mp4 and test-clipped.mp4');

