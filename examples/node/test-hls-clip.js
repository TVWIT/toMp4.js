import toMp4 from '../../src/index.js';
import { writeFileSync } from 'fs';

const url = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

console.log('=== One-step HLS clip (0-10 seconds) ===\n');

const mp4 = await toMp4(url, {
  quality: 'highest',
  startTime: 0,
  endTime: 10,
  onProgress: msg => console.log(msg)
});

writeFileSync('./test-hls-clip.mp4', mp4.data);
console.log(`\n✓ Done: ${mp4.sizeFormatted}`);

