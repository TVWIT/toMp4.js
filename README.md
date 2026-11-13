<div align="center">
  <div><b>toMp4</b></div>
  <div>turn streams into files</div>
  <div><code>npm install @invintusmedia/tomp4</code></div>
</div>

&nbsp;

you've got an HLS stream, or some `.ts` segments, or fMP4 chunks.

you want an `.mp4` file.

```js
import toMp4 from '@invintusmedia/tomp4'

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

### clip to time range

```js
// one-step: download HLS + clip (only fetches needed segments)
const mp4 = await toMp4('https://example.com/stream.m3u8', {
  startTime: 0,
  endTime: 30
})

// clip existing data (frame-accurate using edit lists)
const mp4 = await toMp4(data, {
  startTime: 5,
  endTime: 15
})
```

clips start on the frame that contains `startTime`, with audio cut at the same instant. the source's edit lists (B-frame delay, AAC priming) are honored.

### stitch multiple fMP4 segments

```js
// live stream saved as 4-second fMP4 chunks (each with init+data)
const segments = [segment1, segment2, segment3] // Uint8Array[]
const mp4 = toMp4.stitchFmp4(segments)
mp4.download('combined-stream.mp4')

// or with separate init segment
const mp4 = toMp4.stitchFmp4(dataSegments, { init: initSegment })
```

### stitch multiple MPEG-TS segments

```js
// combine .ts segments into a single MP4
const segments = [segment1, segment2, segment3] // Uint8Array[]
const mp4 = toMp4.stitchTs(segments)
mp4.download('combined.mp4')

// or concatenate into a single continuous TS stream
const tsData = toMp4.concatTs(segments)
```

### analyze without converting

```js
const info = toMp4.analyze(tsData)

info.duration      // 99.5 (seconds)
info.keyframes     // [{index: 0, time: 0}, {index: 150, time: 5.0}, ...]
info.videoCodec    // "H.264/AVC"
info.audioCodec    // "AAC"
```

### progress callback

```js
const mp4 = await toMp4(url, {
  onProgress: (msg, info) => {
    if (info?.percent !== undefined) {
      console.log(`${info.percent}% - ${msg}`)
    }
  }
})
// 10% - Downloading: 10%
// 50% - Downloaded 5.2 MB
// 60% - Frames: 300 video, 450 audio
// 100% - Complete
```

### use the result

```js
mp4.download('video.mp4')   // trigger download
video.src = mp4.toURL()     // play in video element
mp4.data                    // Uint8Array
mp4.toBlob()                // Blob
mp4.toArrayBuffer()         // ArrayBuffer
mp4.revokeURL()             // free memory
```

### thumbnails from your own source

`toMp4.thumbnail()` and `toMp4.thumbnails()` (browser-only) grab frames from HLS and MP4. for an input they can't decode, register a handler that hands over the picture for a given time. scaling, encoding and the result stay the same.

```js
const unregister = toMp4.registerSource({
  name: 'test-card',
  test: (input) => input?.kind === 'test-card',   // does this handler take the input?
  async frame(input, { time }) {                  // the picture at or nearest `time` (seconds)
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 360
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = `hsl(${time * 36} 80% 50%)`
    ctx.fillRect(0, 0, 640, 360)
    return { image: canvas, time }                // + optional close(), called once drawn
  },
})

const img = await toMp4.thumbnail({ kind: 'test-card' }, { time: 5, maxWidth: 160 })
const imgs = await toMp4.thumbnails({ kind: 'test-card' }, { times: [0, 5, 10] })

unregister()
```

- `image` is anything `drawImage` accepts (ImageBitmap, canvas, VideoFrame) or an `ImageData`
- handlers are asked in registration order, before the built-in detection. the first whose `test()` is true wins
- in `thumbnails()`, a time whose `frame()` fails is left out of the Map. the call rejects only when every time failed

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
  import toMp4 from '@invintusmedia/tomp4'
</script>
```

&nbsp;

MIT
