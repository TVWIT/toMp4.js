/**
 * Clipping Tests for toMp4.js
 * 
 * Run with: node tests/clip.test.js
 * 
 * Tests use Big Buck Bunny HLS stream from Mux
 */

import toMp4 from '../src/index.js';

const TEST_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

// Simple test runner
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
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    throw new Error(`${message || 'Value mismatch'}: expected ~${expected}, got ${actual} (diff: ${diff.toFixed(3)})`);
  }
}

async function runTests(tests) {
  console.log('\n📋 Running Clipping Tests\n');
  console.log('═'.repeat(60));
  
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`✅ ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`❌ ${t.name}`);
      console.log(`   ${err.message}`);
      failed++;
    }
  }
  
  console.log('═'.repeat(60));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  
  process.exit(failed > 0 ? 1 : 0);
}

// ============================================
// Tests
// ============================================

const tests = [
  
  test('Download HLS stream (first 10 segments)', async () => {
    console.log('   Downloading test stream...');
    const data = await toMp4.downloadHls(TEST_URL, {
      quality: 'highest',
      maxSegments: 10,
      onProgress: () => {}
    });
    
    assert(data.length > 0, 'Should download data');
    console.log(`   Downloaded ${(data.length / 1024 / 1024).toFixed(2)} MB`);
    
    // Store for other tests
    globalThis.testData = data;
  }),
  
  test('Analyze downloaded stream', async () => {
    const data = globalThis.testData;
    assert(data, 'Need test data from previous test');
    
    const info = toMp4.analyze(data);
    console.log(`   Duration: ${info.duration.toFixed(2)}s`);
    console.log(`   Frames: ${info.videoFrames} video, ${info.audioFrames} audio`);
    console.log(`   Keyframes: ${info.keyframeCount} (every ${(info.duration / info.keyframeCount).toFixed(1)}s)`);
    
    // Log keyframe positions
    console.log(`   Keyframe times: ${info.keyframes.slice(0, 10).map(k => k.time.toFixed(2)).join(', ')}...`);
    
    assert(info.duration > 0, 'Should have duration');
    assert(info.videoFrames > 0, 'Should have video frames');
    assert(info.keyframeCount > 0, 'Should have keyframes');
    
    globalThis.streamInfo = info;
  }),
  
  test('Clip 0-5 seconds', async () => {
    const data = globalThis.testData;
    const info = globalThis.streamInfo;
    
    const mp4 = await toMp4(data, {
      startTime: 0,
      endTime: 5,
      onProgress: () => {}
    });
    
    // Play in a video element would show actual duration
    // For now, analyze the output
    console.log(`   Output size: ${mp4.sizeFormatted}`);
    
    assert(mp4.data.length > 0, 'Should produce output');
  }),
  
  test('Clip 31-35 seconds (precise clipping with preroll)', async () => {
    const data = globalThis.testData;
    const info = globalThis.streamInfo;
    
    console.log(`   Stream duration: ${info.duration.toFixed(2)}s`);
    
    // Find keyframes near our clip range
    const keyframesInRange = info.keyframes.filter(k => k.time >= 25 && k.time <= 40);
    console.log(`   Keyframes near 31-35s: ${keyframesInRange.map(k => k.time.toFixed(2)).join(', ')}`);
    
    // The nearest keyframe BEFORE 31s is used for decoding, but not reported
    const keyframeBefore31 = info.keyframes.filter(k => k.time <= 31).pop();
    console.log(`   Nearest keyframe before 31s: ${keyframeBefore31?.time.toFixed(2)}s (used for decode preroll)`);
    
    if (info.duration < 35) {
      console.log(`   ⚠️  Stream is only ${info.duration.toFixed(2)}s - skipping 31-35s test`);
      return;
    }
    
    let actualStart = null, actualEnd = null, prerollMs = null;
    const mp4 = await toMp4(data, {
      startTime: 31,
      endTime: 35,
      onProgress: (msg) => {
        if (msg.includes('Clipped:')) {
          const match = msg.match(/Clipped: ([\d.]+)s - ([\d.]+)s \(([\d.]+)s, (\d+)ms preroll\)/);
          if (match) {
            actualStart = parseFloat(match[1]);
            actualEnd = parseFloat(match[2]);
            prerollMs = parseInt(match[4]);
          }
          console.log(`   ${msg}`);
        }
      }
    });
    
    console.log(`   Output size: ${mp4.sizeFormatted}`);
    
    // Document expected behavior
    console.log('');
    console.log('   📝 EXPECTED BEHAVIOR:');
    console.log(`   Requested: 31.00s - 35.00s (4.00s duration)`);
    console.log(`   Reported:  ${actualStart?.toFixed(2)}s - ${actualEnd?.toFixed(2)}s (${(actualEnd - actualStart).toFixed(2)}s duration)`);
    console.log(`   Preroll:   ${prerollMs}ms (decoder starts at keyframe ${keyframeBefore31?.time.toFixed(2)}s)`);
    console.log('   ✓ Duration matches requested time, preroll handles keyframe decoding');
    
    assert(mp4.data.length > 0, 'Should produce output');
    
    // Verify precise clipping - reported times should match requested times
    assertApprox(actualStart, 31, 0.1, 'Reported start should match requested start');
    assertApprox(actualEnd - actualStart, 4, 0.1, 'Duration should be ~4 seconds as requested');
    
    // Verify preroll exists (keyframe is before requested start)
    if (keyframeBefore31 && keyframeBefore31.time < 31) {
      assert(prerollMs > 0, 'Should have preroll when keyframe is before requested start');
    }
  }),
  
  test('Clip uses preroll for precise start times', async () => {
    const data = globalThis.testData;
    const info = globalThis.streamInfo;
    
    if (info.keyframes.length < 3) {
      console.log('   Not enough keyframes to test');
      return;
    }
    
    // Pick a start time between two keyframes
    const kf1 = info.keyframes[1];
    const kf2 = info.keyframes[2];
    const midTime = (kf1.time + kf2.time) / 2;
    
    console.log(`   Keyframe 1: ${kf1.time.toFixed(2)}s`);
    console.log(`   Keyframe 2: ${kf2.time.toFixed(2)}s`);
    console.log(`   Requesting start: ${midTime.toFixed(2)}s (between keyframes)`);
    
    let reportedStart = null, prerollMs = null;
    const mp4 = await toMp4(data, {
      startTime: midTime,
      endTime: midTime + 5,
      onProgress: (msg) => {
        if (msg.includes('Clipped:')) {
          const match = msg.match(/Clipped: ([\d.]+)s.*?(\d+)ms preroll/);
          if (match) {
            reportedStart = parseFloat(match[1]);
            prerollMs = parseInt(match[2]);
          }
          console.log(`   ${msg}`);
        }
      }
    });
    
    // With precise clipping, reported start should match requested, not keyframe
    if (reportedStart !== null) {
      assertApprox(reportedStart, midTime, 0.1, 
        `Reported start should match requested ${midTime.toFixed(2)}s`);
      console.log(`   ✓ Reported start matches requested time`);
      
      // Preroll should account for the gap between keyframe and requested start
      const expectedPreroll = (midTime - kf1.time) * 1000;
      assertApprox(prerollMs, expectedPreroll, 100, 
        `Preroll should be ~${expectedPreroll.toFixed(0)}ms`);
      console.log(`   ✓ Preroll (${prerollMs}ms) accounts for keyframe offset`);
    }
  }),
  
  test('Clip entire duration (no start/end)', async () => {
    const data = globalThis.testData;
    
    const mp4 = await toMp4(data, {
      onProgress: () => {}
    });
    
    console.log(`   Output size: ${mp4.sizeFormatted}`);
    assert(mp4.data.length > 0, 'Should produce output');
  }),
  
  test('Clip with only endTime', async () => {
    const data = globalThis.testData;
    
    const mp4 = await toMp4(data, {
      endTime: 10,
      onProgress: (msg) => {
        if (msg.includes('Clipped:')) console.log(`   ${msg}`);
      }
    });
    
    console.log(`   Output size: ${mp4.sizeFormatted}`);
    assert(mp4.data.length > 0, 'Should produce output');
  }),
  
  test('Clip with only startTime', async () => {
    const data = globalThis.testData;
    const info = globalThis.streamInfo;
    
    const mp4 = await toMp4(data, {
      startTime: 5,
      onProgress: (msg) => {
        if (msg.includes('Clipped:')) console.log(`   ${msg}`);
      }
    });
    
    console.log(`   Output size: ${mp4.sizeFormatted}`);
    assert(mp4.data.length > 0, 'Should produce output');
  }),

];

// Run
runTests(tests);

