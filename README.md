<div align="center">
  <div><b>toMp4</b></div>
  <div>turn streams into files</div>
  <div><code>npm install tomp4</code></div>
</div>

&nbsp;

you've got an HLS stream, or some `.ts` segments, or fMP4 chunks.

you want an `.mp4` file.

```js
import toMp4 from 'tomp4'

const mp4 = await toMp4('https://example.com/stream.m3u8')
mp4.download('my-video.mp4')
```

that's it. no ffmpeg. no wasm. no dependencies.

&nbsp;

### from different sources

```js
// HLS playlist (auto-picks highest quality)
const mp4 = await toMp4('https://example.com/master.m3u8')

// single .ts segment
const mp4 = await toMp4('https://example.com/segment.ts')

// raw bytes you already have
const mp4 = await toMp4(uint8Array)

// pick your quality
const hls = await toMp4.parseHls('https://example.com/master.m3u8')
console.log(hls.qualities) // ['1080p', '720p', '480p']
const mp4 = await toMp4(hls.select('720p'))
```

### use the result

```js
// download it
mp4.download('video.mp4')

// play it
video.src = mp4.toURL()

// get the bytes
mp4.data // Uint8Array
mp4.toArrayBuffer()
mp4.toBlob()
```

&nbsp;

### what it does

remuxes video. no transcoding.

| input | output |
|-------|--------|
| `.ts` (MPEG-TS) | `.mp4` |
| `.m4s` (fMP4) | `.mp4` |
| `.m3u8` (HLS) | `.mp4` |

video: H.264, H.265  
audio: AAC

&nbsp;

### what it doesn't do

- transcode (no converting h264→h265, etc)
- handle DRM/encrypted streams
- support MP3, AC-3 audio (yet)

&nbsp;

### browser + node

works in both. ~50kb minified.

```html
<script type="module">
  import toMp4 from './dist/tomp4.js'
</script>
```

&nbsp;

MIT

