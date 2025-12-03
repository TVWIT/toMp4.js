import toMp4 from '../../src/index.js';

const url = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

console.log('=== Testing progress callback ===\n');

const mp4 = await toMp4(url, {
  quality: 'highest',
  maxSegments: 5,
  onProgress: (msg, info) => {
    if (info?.percent !== undefined) {
      console.log(`[${info.percent}%] ${msg}`);
    } else {
      console.log(msg);
    }
  }
});

console.log(`\n✓ Done: ${mp4.sizeFormatted}`);

