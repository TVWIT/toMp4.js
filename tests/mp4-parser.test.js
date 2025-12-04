/**
 * MP4 Parser Tests
 * 
 * Tests for MP4Parser (local) and RemoteMp4 (remote) functionality.
 * 
 * Run: node tests/mp4-parser.test.js
 */

import { MP4Parser, RemoteMp4 } from '../src/index.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// Test URLs
const REMOTE_MP4_URL = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
const SHORT_MP4_URL = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_1MB.mp4';

// Test state
let passed = 0;
let failed = 0;

function test(name, fn) {
  return { name, fn };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertApprox(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(message || `Expected ~${expected}, got ${actual}`);
  }
}

async function runTests(tests) {
  console.log('\n' + '═'.repeat(60));
  console.log('   MP4 Parser Tests');
  console.log('═'.repeat(60) + '\n');
  
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (err) {
      console.log(`❌ ${name}`);
      console.log(`   Error: ${err.message}`);
      failed++;
    }
  }
  
  console.log('\n' + '─'.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(60) + '\n');
  
  process.exit(failed > 0 ? 1 : 0);
}

// ============================================================================
// RemoteMp4 Tests
// ============================================================================

const remoteMp4Tests = [
  test('RemoteMp4.fromUrl() parses remote MP4', async () => {
    const source = await RemoteMp4.fromUrl(SHORT_MP4_URL);
    
    assert(source.duration > 0, 'Should have duration');
    assert(source.segments.length > 0, 'Should have segments');
    assert(source.videoSamples.length > 0, 'Should have video samples');
  }),
  
  test('RemoteMp4 extracts correct duration', async () => {
    const source = await RemoteMp4.fromUrl(SHORT_MP4_URL);
    
    // 10 second video
    assertApprox(source.duration, 10, 1, 'Duration should be ~10s');
  }),
  
  test('RemoteMp4 detects video properties', async () => {
    const source = await RemoteMp4.fromUrl(SHORT_MP4_URL);
    
    assert(source.width > 0, 'Should have width');
    assert(source.height > 0, 'Should have height');
    console.log(`   Dimensions: ${source.width}x${source.height}`);
  }),
  
  test('RemoteMp4 builds segments at keyframes', async () => {
    const source = await RemoteMp4.fromUrl(SHORT_MP4_URL);
    
    for (const segment of source.segments) {
      const firstSample = source.videoSamples[segment.videoStart];
      assert(firstSample.isKeyframe, `Segment ${segment.index} should start with keyframe`);
    }
  }),
  
  test('RemoteMp4.getInfo() returns expected properties', async () => {
    const source = await RemoteMp4.fromUrl(SHORT_MP4_URL);
    const info = source.getInfo();
    
    assert(info.url === SHORT_MP4_URL, 'Should have URL');
    assert(info.fileSize > 0, 'Should have file size');
    assert(info.duration > 0, 'Should have duration');
    assert(info.videoSampleCount > 0, 'Should have video samples');
    assert(typeof info.hasAudio === 'boolean', 'Should have hasAudio');
    assert(typeof info.hasBframes === 'boolean', 'Should have hasBframes');
  }),
  
  test('RemoteMp4.getMasterPlaylist() generates valid HLS', async () => {
    const source = await RemoteMp4.fromUrl(SHORT_MP4_URL);
    const playlist = source.getMasterPlaylist();
    
    assert(playlist.includes('#EXTM3U'), 'Should have EXTM3U');
    assert(playlist.includes('#EXT-X-STREAM-INF'), 'Should have stream info');
    assert(playlist.includes('BANDWIDTH='), 'Should have bandwidth');
    assert(playlist.includes('playlist.m3u8'), 'Should reference media playlist');
  }),
  
  test('RemoteMp4.getMediaPlaylist() generates valid HLS', async () => {
    const source = await RemoteMp4.fromUrl(SHORT_MP4_URL);
    const playlist = source.getMediaPlaylist();
    
    assert(playlist.includes('#EXTM3U'), 'Should have EXTM3U');
    assert(playlist.includes('#EXT-X-TARGETDURATION'), 'Should have target duration');
    assert(playlist.includes('#EXT-X-PLAYLIST-TYPE:VOD'), 'Should be VOD');
    assert(playlist.includes('#EXT-X-ENDLIST'), 'Should have endlist');
    assert(playlist.includes('#EXTINF:'), 'Should have segment durations');
    assert(playlist.includes('segment0.ts'), 'Should have segment references');
  }),
  
  test('RemoteMp4.getMediaPlaylist() with baseUrl', async () => {
    const source = await RemoteMp4.fromUrl(SHORT_MP4_URL);
    const playlist = source.getMediaPlaylist('https://cdn.example.com/');
    
    assert(playlist.includes('https://cdn.example.com/segment0.ts'), 'Should use baseUrl');
  }),
  
  test('RemoteMp4.getSegment() returns MPEG-TS data', async () => {
    const source = await RemoteMp4.fromUrl(SHORT_MP4_URL);
    const segment = await source.getSegment(0);
    
    assert(segment instanceof Uint8Array, 'Should return Uint8Array');
    assert(segment.length > 0, 'Should have data');
    assert(segment[0] === 0x47, 'Should start with TS sync byte');
    
    // Check for multiple sync bytes (valid TS packets)
    let syncCount = 0;
    for (let i = 0; i < segment.length; i += 188) {
      if (segment[i] === 0x47) syncCount++;
    }
    assert(syncCount > 10, 'Should have many valid TS packets');
    
    console.log(`   Segment 0: ${(segment.length / 1024).toFixed(1)} KB, ${syncCount} packets`);
  }),
  
  test('RemoteMp4.getSegment() with audio', async () => {
    const source = await RemoteMp4.fromUrl(SHORT_MP4_URL);
    
    if (source.hasAudio) {
      const segment = await source.getSegment(0);
      // Audio PID is typically 0x102 in our muxer
      // Just verify we got a reasonably sized segment
      assert(segment.length > 50000, 'Segment with audio should be larger');
      console.log(`   Has audio: ${source.audioSamples.length} samples`);
    } else {
      console.log('   No audio track in test video');
    }
  }),
  
  test('RemoteMp4.getSegments() returns segment info', async () => {
    const source = await RemoteMp4.fromUrl(SHORT_MP4_URL);
    const segments = source.getSegments();
    
    assert(Array.isArray(segments), 'Should return array');
    assert(segments.length > 0, 'Should have segments');
    
    for (const seg of segments) {
      assert(typeof seg.index === 'number', 'Should have index');
      assert(typeof seg.startTime === 'number', 'Should have startTime');
      assert(typeof seg.endTime === 'number', 'Should have endTime');
      assert(typeof seg.duration === 'number', 'Should have duration');
      assert(seg.duration > 0, 'Duration should be positive');
    }
  }),
];

// ============================================================================
// RemoteMp4 Error Handling Tests
// ============================================================================

const errorTests = [
  test('RemoteMp4 throws on invalid URL', async () => {
    try {
      await RemoteMp4.fromUrl('https://example.com/nonexistent.mp4');
      throw new Error('Should have thrown');
    } catch (err) {
      assert(err.message.includes('HTTP') || err.message.includes('fetch'), 
             'Should throw HTTP error');
    }
  }),
  
  test('RemoteMp4.getSegment() throws on invalid index', async () => {
    const source = await RemoteMp4.fromUrl(SHORT_MP4_URL);
    
    try {
      await source.getSegment(99999);
      throw new Error('Should have thrown');
    } catch (err) {
      assert(err.message.includes('not found'), 'Should throw not found error');
    }
  }),
];

// ============================================================================
// MP4Parser Local Tests (if we have a local file)
// ============================================================================

const localParserTests = [
  test('MP4Parser class is exported', async () => {
    assert(typeof MP4Parser === 'function', 'MP4Parser should be a function');
  }),
  
  test('MP4Parser can be constructed with data', async () => {
    // Download a small test file
    const response = await fetch(SHORT_MP4_URL);
    const data = new Uint8Array(await response.arrayBuffer());
    
    const parser = new MP4Parser(data);
    
    assert(parser.duration > 0, 'Should have duration');
    assert(parser.videoSamples.length > 0, 'Should have video samples');
    
    console.log(`   Local parse: ${parser.duration.toFixed(1)}s, ${parser.videoSamples.length} samples`);
  }),
  
  test('MP4Parser.getVideoSamples() returns samples', async () => {
    const response = await fetch(SHORT_MP4_URL);
    const data = new Uint8Array(await response.arrayBuffer());
    const parser = new MP4Parser(data);
    
    const samples = parser.getVideoSamples();
    
    assert(Array.isArray(samples), 'Should return array');
    assert(samples.length > 0, 'Should have samples');
    
    const firstSample = samples[0];
    assert(typeof firstSample.index === 'number', 'Should have index');
    assert(typeof firstSample.offset === 'number', 'Should have offset');
    assert(typeof firstSample.size === 'number', 'Should have size');
    assert(typeof firstSample.dts === 'number', 'Should have dts');
    assert(typeof firstSample.pts === 'number', 'Should have pts');
    assert(typeof firstSample.isKeyframe === 'boolean', 'Should have isKeyframe');
  }),
  
  test('MP4Parser.getAudioSamples() returns samples', async () => {
    const response = await fetch(SHORT_MP4_URL);
    const data = new Uint8Array(await response.arrayBuffer());
    const parser = new MP4Parser(data);
    
    if (parser.hasAudio) {
      const samples = parser.getAudioSamples();
      assert(Array.isArray(samples), 'Should return array');
      assert(samples.length > 0, 'Should have audio samples');
      console.log(`   Audio samples: ${samples.length}`);
    } else {
      console.log('   No audio track');
    }
  }),
  
  test('MP4Parser.buildSegments() creates segments', async () => {
    const response = await fetch(SHORT_MP4_URL);
    const data = new Uint8Array(await response.arrayBuffer());
    const parser = new MP4Parser(data);
    
    const segments = parser.buildSegments(4);
    
    assert(Array.isArray(segments), 'Should return array');
    assert(segments.length > 0, 'Should have segments');
    
    // Verify segments are at keyframes
    for (const seg of segments) {
      const firstSample = parser.videoSamples[seg.videoStart];
      assert(firstSample.isKeyframe, `Segment ${seg.index} should start at keyframe`);
    }
    
    console.log(`   Segments: ${segments.length}`);
  }),
  
  test('MP4Parser.getSampleData() extracts sample data', async () => {
    const response = await fetch(SHORT_MP4_URL);
    const data = new Uint8Array(await response.arrayBuffer());
    const parser = new MP4Parser(data);
    
    const samples = parser.getVideoSamples().slice(0, 5);
    const samplesWithData = parser.getSampleData(samples);
    
    for (const sample of samplesWithData) {
      assert(sample.data instanceof Uint8Array, 'Should have data');
      assert(sample.data.length === sample.size, 'Data length should match size');
    }
    
    console.log(`   Extracted ${samplesWithData.length} samples`);
  }),
  
  test('MP4Parser.getInfo() returns info object', async () => {
    const response = await fetch(SHORT_MP4_URL);
    const data = new Uint8Array(await response.arrayBuffer());
    const parser = new MP4Parser(data);
    
    const info = parser.getInfo();
    
    assert(info.duration > 0, 'Should have duration');
    assert(info.videoSampleCount > 0, 'Should have video samples');
    assert(typeof info.hasAudio === 'boolean', 'Should have hasAudio');
    assert(typeof info.hasBframes === 'boolean', 'Should have hasBframes');
    assert(info.keyframeCount > 0, 'Should have keyframes');
  }),
  
  test('MP4Parser detects B-frames via ctts', async () => {
    const response = await fetch(SHORT_MP4_URL);
    const data = new Uint8Array(await response.arrayBuffer());
    const parser = new MP4Parser(data);
    
    // Just verify the property exists and is boolean
    assert(typeof parser.hasBframes === 'boolean', 'Should detect B-frames');
    console.log(`   Has B-frames: ${parser.hasBframes}`);
  }),
  
  test('MP4Parser video codec config', async () => {
    const response = await fetch(SHORT_MP4_URL);
    const data = new Uint8Array(await response.arrayBuffer());
    const parser = new MP4Parser(data);
    
    const config = parser.videoCodecConfig;
    
    if (config) {
      assert(Array.isArray(config.sps), 'Should have SPS');
      assert(Array.isArray(config.pps), 'Should have PPS');
      assert(config.sps.length > 0, 'Should have at least one SPS');
      assert(config.pps.length > 0, 'Should have at least one PPS');
      console.log(`   SPS: ${config.sps[0].length} bytes, PPS: ${config.pps[0].length} bytes`);
    } else {
      console.log('   No codec config (non-AVC video)');
    }
  }),
];

// ============================================================================
// Integration Tests
// ============================================================================

const integrationTests = [
  test('RemoteMp4 segment can be played (basic validation)', async () => {
    const source = await RemoteMp4.fromUrl(SHORT_MP4_URL);
    const segment = await source.getSegment(0);
    
    // Validate TS structure
    const packetCount = Math.floor(segment.length / 188);
    let validPackets = 0;
    
    for (let i = 0; i < packetCount; i++) {
      const offset = i * 188;
      if (segment[offset] === 0x47) {
        validPackets++;
      }
    }
    
    const validity = (validPackets / packetCount * 100).toFixed(1);
    assert(validPackets === packetCount, `All packets should be valid (${validity}%)`);
    
    console.log(`   ${packetCount} packets, ${validity}% valid`);
  }),
  
  test('MP4Parser and RemoteMp4 produce consistent results', async () => {
    // Parse same file locally and remotely
    const response = await fetch(SHORT_MP4_URL);
    const data = new Uint8Array(await response.arrayBuffer());
    const localParser = new MP4Parser(data);
    
    const remoteSource = await RemoteMp4.fromUrl(SHORT_MP4_URL);
    
    // Compare results
    assertApprox(localParser.duration, remoteSource.duration, 0.1, 
                 'Duration should match');
    assert(localParser.videoSamples.length === remoteSource.videoSamples.length,
           'Video sample count should match');
    assert(localParser.hasAudio === remoteSource.hasAudio,
           'hasAudio should match');
    
    console.log(`   Both parsers: ${localParser.duration.toFixed(1)}s, ${localParser.videoSamples.length} samples`);
  }),
];

// ============================================================================
// Run All Tests
// ============================================================================

const allTests = [
  ...remoteMp4Tests,
  ...errorTests,
  ...localParserTests,
  ...integrationTests,
];

runTests(allTests);

