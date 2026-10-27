/**
 * Clip accuracy against real encodes: B-frames (edit list for the B-frame
 * delay) and AAC priming, packaged as MPEG-TS HLS, muxed CMAF HLS, demuxed
 * CMAF HLS and a progressive MP4. For every clip the first frame shown must be
 * the frame that contains the requested start, and audio must start at the
 * same instant.
 *
 * Content is identified, not timestamps: decoded video frames by MD5, audio
 * packets by data hash, both looked up in the source.
 *
 * Needs ffmpeg/ffprobe; skipped without them.
 *
 * Run: node tests/clip-sync.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import toMp4, { clipMp4 } from '../src/index.js';

let ffmpegOk = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
} catch {
  ffmpegOk = false;
}

const FRAME = 1001 / 30000;

const run = (cmd, args) => execFileSync(cmd, ['-v', 'error', ...args], { maxBuffer: 1 << 28 });

function buildMedia(dir) {
  const src = join(dir, 'src.mp4');
  run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30000/1001',
    '-f', 'lavfi', '-i', 'anoisesrc=sample_rate=48000:seed=7:amplitude=0.3', '-t', '20',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-profile:v', 'high', '-bf', '2', '-g', '60', '-keyint_min', '60',
    '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', src]);
  const hls = ['-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'vod'];
  const fmp4 = ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4'];
  for (const d of ['ts', 'cmaf', 'demux']) mkdirSync(join(dir, d));
  run('ffmpeg', ['-y', '-i', src, '-c', 'copy', ...hls, '-hls_segment_filename', join(dir, 'ts/seg%d.ts'), join(dir, 'ts/index.m3u8')]);
  run('ffmpeg', ['-y', '-i', src, '-c', 'copy', ...hls, ...fmp4, '-hls_segment_filename', join(dir, 'cmaf/seg%d.m4s'), join(dir, 'cmaf/index.m3u8')]);
  // One ffmpeg run for both renditions, so they share a timeline.
  run('ffmpeg', ['-y', '-i', src, '-map', '0:v', '-map', '0:a', '-c', 'copy', ...hls, ...fmp4,
    '-var_stream_map', 'v:0,agroup:aud a:0,agroup:aud',
    '-hls_segment_filename', join(dir, 'demux/s%v/seg%d.m4s'), join(dir, 'demux/s%v/index.m3u8')]);
  writeFileSync(join(dir, 'demux/master.m3u8'), [
    '#EXTM3U', '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",DEFAULT=YES,URI="s1/index.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.640015,mp4a.40.2",AUDIO="aud"',
    's0/index.m3u8', '',
  ].join('\n'));
  return src;
}

/** Decoded video frames in output order: [{ pts, md5 }] (timestamps as demuxed). */
function videoFrames(file) {
  const lines = run('ffmpeg', ['-copyts', '-i', file, '-map', '0:v', '-f', 'framemd5', '-']).toString().split('\n');
  const [num, den] = lines.find(l => l.startsWith('#tb 0')).split(':')[1].trim().split('/').map(Number);
  return lines.filter(l => l && !l.startsWith('#')).map(l => {
    const c = l.split(',').map(x => x.trim());
    return { pts: Number(c[1]) * num / den, md5: c[5] };
  });
}

/** Audio packets: [{ pts, hash }]. */
function audioPackets(file) {
  const json = JSON.parse(run('ffprobe', ['-of', 'json', '-select_streams', 'a:0', '-show_packets',
    '-show_entries', 'packet=pts_time,data_hash', '-show_data_hash', 'MD5', file]).toString());
  return json.packets.map(p => ({ pts: Number(p.pts_time), hash: p.data_hash }));
}

/** Source time shown first, and the A/V offset (seconds; + = audio early). */
function measure(source, file) {
  const v = videoFrames(file);
  const firstV = source.video.get(v[0].md5);
  assert.ok(firstV !== undefined, 'first frame comes from the source');
  const a = audioPackets(file).find(p => p.pts >= 0);
  assert.ok(a?.hash, 'audio packets carry a data hash');
  const srcA = source.audio.get(a.hash);
  assert.ok(srcA !== undefined, 'audio comes from the source');
  // Source time minus output time, per track: equal when in sync.
  return { firstVideo: firstV, avOffset: (srcA - a.pts) - (firstV - v[0].pts) };
}

test('clips start on the right frame with audio in sync', { skip: !ffmpegOk && 'ffmpeg/ffprobe not installed' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tomp4-clip-sync-'));
  const server = http.createServer((req, res) => {
    const f = join(dir, decodeURIComponent(req.url.split('?')[0]));
    if (!existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200);
    res.end(readFileSync(f));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const srcPath = buildMedia(dir);
  const source = {
    video: new Map(videoFrames(srcPath).map(f => [f.md5, f.pts])),
    audio: new Map(audioPackets(srcPath).map(p => [p.hash, p.pts])),
  };

  const inputs = {
    'MPEG-TS HLS': `${base}/ts/index.m3u8`,
    'muxed CMAF HLS': `${base}/cmaf/index.m3u8`,
    'demuxed CMAF HLS': `${base}/demux/master.m3u8`,
    'MP4 (clipMp4)': null,
  };
  // Mid-stream on a keyframe, between frames, and inside the first segment.
  const ranges = [[10.01, 13.5], [10, 14], [0.5, 4]];

  for (const [label, url] of Object.entries(inputs)) {
    await t.test(label, async () => {
      for (const [startTime, endTime] of ranges) {
        const data = url
          ? (await toMp4(url, { startTime, endTime, onProgress: () => { } })).data
          : clipMp4(new Uint8Array(readFileSync(srcPath)), { startTime, endTime });
        const out = join(dir, `out-${label.replace(/\W+/g, '-')}-${startTime}.mp4`);
        writeFileSync(out, data);
        const { firstVideo, avOffset } = measure(source, out);
        assert.ok(firstVideo <= startTime + 1e-6 && startTime < firstVideo + FRAME - 1e-6,
          `${startTime}s: first frame shown is the one containing the start (got ${firstVideo.toFixed(3)}s)`);
        assert.ok(Math.abs(avOffset) < 0.001, `${startTime}s: A/V offset ${(avOffset * 1000).toFixed(1)} ms`);
      }
    });
  }
});
