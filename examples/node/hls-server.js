/**
 * Remote MP4 → HLS Server Example
 * 
 * Serves HLS streams from remote MP4 files on-demand.
 * Only downloads MP4 metadata upfront, then fetches segments as needed.
 * 
 * Usage:
 *   node examples/node/hls-server.js [mp4-url] [port]
 * 
 * Example:
 *   node examples/node/hls-server.js http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4 8080
 * 
 * Then open http://localhost:8080 in a browser or:
 *   ffplay http://localhost:8080/stream.m3u8
 */

import http from 'http';
import { RemoteMp4 } from '../../src/index.js';

const DEFAULT_URL = 'http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
const DEFAULT_PORT = 8080;

const mp4Url = process.argv[2] || DEFAULT_URL;
const port = parseInt(process.argv[3]) || DEFAULT_PORT;

console.log('🎬 Remote MP4 → HLS Server');
console.log('─'.repeat(50));
console.log(`Source: ${mp4Url}`);
console.log(`Port:   ${port}`);
console.log('');

let remoteMp4 = null;
let stats = { segmentsFetched: 0, bytesServed: 0 };

async function init() {
  console.log('📦 Parsing MP4 metadata...');
  remoteMp4 = await RemoteMp4.fromUrl(mp4Url);
  
  const info = remoteMp4.getInfo();
  console.log(`✓ Duration: ${(info.duration / 60).toFixed(1)} min`);
  console.log(`✓ Resolution: ${info.width}×${info.height}`);
  console.log(`✓ Segments: ${info.segmentCount}`);
  console.log(`✓ Has audio: ${info.hasAudio}`);
  console.log('');
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const path = url.pathname;
  
  // CORS headers for browser playback
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // Serve index page
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(generateIndexPage());
      return;
    }
    
    // Master playlist
    if (path === '/master.m3u8') {
      const playlist = remoteMp4.getMasterPlaylist('/');
      res.writeHead(200, { 
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache'
      });
      res.end(playlist);
      console.log('📋 Served master playlist');
      return;
    }
    
    // Media playlist
    if (path === '/stream.m3u8' || path === '/playlist.m3u8') {
      const playlist = remoteMp4.getMediaPlaylist('/');
      res.writeHead(200, { 
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache'
      });
      res.end(playlist);
      console.log('📋 Served media playlist');
      return;
    }
    
    // Segment request
    const segMatch = path.match(/\/segment(\d+)\.ts/);
    if (segMatch) {
      const index = parseInt(segMatch[1]);
      console.log(`📥 Fetching segment ${index}...`);
      
      const startTime = Date.now();
      const data = await remoteMp4.getSegment(index);
      const elapsed = Date.now() - startTime;
      
      stats.segmentsFetched++;
      stats.bytesServed += data.length;
      
      res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Content-Length': data.length,
        'Cache-Control': 'max-age=3600'
      });
      res.end(Buffer.from(data));
      
      console.log(`✓ Segment ${index}: ${formatBytes(data.length)} in ${elapsed}ms (total: ${formatBytes(stats.bytesServed)})`);
      return;
    }
    
    // Info endpoint
    if (path === '/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...remoteMp4.getInfo(),
        stats
      }, null, 2));
      return;
    }
    
    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Error: ${err.message}`);
  }
});

function generateIndexPage() {
  const info = remoteMp4.getInfo();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Remote MP4 → HLS | toMp4.js</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: system-ui, sans-serif;
      background: #111827;
      color: #f3f4f6;
      min-height: 100vh;
      padding: 40px 20px;
    }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { 
      font-size: 2rem;
      margin-bottom: 8px;
    }
    h1 span { color: #7BC93C; }
    .tagline { color: #9ca3af; margin-bottom: 32px; }
    .info-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .info-item {
      background: #1f2937;
      border-radius: 8px;
      padding: 16px;
      text-align: center;
    }
    .info-item .label {
      font-size: 0.75rem;
      color: #9ca3af;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 4px;
    }
    .info-item .value {
      font-size: 1.25rem;
      font-weight: 600;
    }
    .player-container {
      background: #000;
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 24px;
    }
    video { width: 100%; display: block; }
    .stats {
      background: #1f2937;
      border-radius: 8px;
      padding: 16px;
      font-family: monospace;
      font-size: 0.85rem;
      color: #9ca3af;
    }
    .stats .highlight { color: #7BC93C; }
  </style>
</head>
<body>
  <div class="container">
    <h1><span>Remote MP4</span> → HLS</h1>
    <p class="tagline">On-demand HLS streaming from hosted MP4 files</p>
    
    <div class="info-grid">
      <div class="info-item">
        <div class="label">Duration</div>
        <div class="value">${Math.floor(info.duration / 60)}:${String(Math.floor(info.duration % 60)).padStart(2, '0')}</div>
      </div>
      <div class="info-item">
        <div class="label">Resolution</div>
        <div class="value">${info.width}×${info.height}</div>
      </div>
      <div class="info-item">
        <div class="label">Segments</div>
        <div class="value">${info.segmentCount}</div>
      </div>
      <div class="info-item">
        <div class="label">Audio</div>
        <div class="value">${info.hasAudio ? 'Yes' : 'No'}</div>
      </div>
    </div>
    
    <div class="player-container">
      <video id="video" controls></video>
    </div>
    
    <div class="stats">
      <div>Stream URL: <span class="highlight">/stream.m3u8</span></div>
      <div>Source: <span class="highlight">${mp4Url}</span></div>
      <div id="playback-stats"></div>
    </div>
  </div>
  
  <script>
    const video = document.getElementById('video');
    const statsEl = document.getElementById('playback-stats');
    
    if (Hls.isSupported()) {
      const hls = new Hls({
        debug: false,
        enableWorker: true
      });
      
      hls.loadSource('/stream.m3u8');
      hls.attachMedia(video);
      
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('HLS manifest loaded');
      });
      
      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error('HLS error:', data);
      });
      
      // Update stats
      setInterval(async () => {
        try {
          const res = await fetch('/info');
          const info = await res.json();
          statsEl.innerHTML = \`Segments fetched: <span class="highlight">\${info.stats.segmentsFetched}</span> | Data served: <span class="highlight">\${formatBytes(info.stats.bytesServed)}</span>\`;
        } catch (e) {}
      }, 1000);
      
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = '/stream.m3u8';
    }
    
    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }
  </script>
</body>
</html>`;
}

// Start server
init().then(() => {
  server.listen(port, () => {
    console.log('🚀 Server running!');
    console.log('');
    console.log(`   Browser:  http://localhost:${port}`);
    console.log(`   HLS URL:  http://localhost:${port}/stream.m3u8`);
    console.log(`   ffplay:   ffplay http://localhost:${port}/stream.m3u8`);
    console.log('');
    console.log('Press Ctrl+C to stop');
    console.log('─'.repeat(50));
  });
}).catch(err => {
  console.error('Failed to initialize:', err.message);
  process.exit(1);
});

