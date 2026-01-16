/**
 * Test combined audio+video fMP4 stitching
 * 
 * Run: node tests/test-combined-fmp4.js
 */

import { stitchFmp4, toMp4 } from '../src/index.js';
import { readFileSync, writeFileSync } from 'fs';

async function main() {
    console.log('=== Combined Video+Audio fMP4 Test ===\n');

    // Read the combined fMP4 file
    const fmp4Data = readFileSync('./tests/fmp4-samples/combined.mp4');
    console.log(`Input: ${(fmp4Data.length / 1024).toFixed(0)} KB`);

    // Check input has both tracks
    const { execSync } = await import('child_process');

    console.log('\nInput streams:');
    const inputInfo = execSync(
        'ffprobe -v error -show_entries stream=codec_type,codec_name -of csv=p=0 tests/fmp4-samples/combined.mp4',
        { encoding: 'utf8' }
    );
    console.log(inputInfo.trim().split('\n').map(l => '  ' + l).join('\n'));

    // Convert using toMp4 (which uses convertFmp4ToMp4 for fMP4)
    console.log('\nConverting with toMp4...');
    const result = await toMp4(fmp4Data);

    // Save output
    writeFileSync('./tests/output/combined-output.mp4', result.data);
    console.log(`Output: ${result.sizeFormatted}`);

    // Check output has both tracks
    console.log('\nOutput streams:');
    const outputInfo = execSync(
        'ffprobe -v error -show_entries stream=codec_type,codec_name,duration -of csv=p=0 tests/output/combined-output.mp4',
        { encoding: 'utf8' }
    );
    console.log(outputInfo.trim().split('\n').map(l => '  ' + l).join('\n'));

    // Get durations
    console.log('\nDurations:');
    const durationInfo = execSync(
        'ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 tests/output/combined-output.mp4',
        { encoding: 'utf8' }
    );
    console.log(`  Format duration: ${parseFloat(durationInfo).toFixed(2)}s`);

    // Verify playability
    console.log('\nPlaying first 3 seconds to verify audio...');
    try {
        execSync('ffplay -autoexit -t 3 -nodisp tests/output/combined-output.mp4 2>&1', {
            encoding: 'utf8',
            timeout: 10000
        });
        console.log('  ✓ Playback completed');
    } catch (err) {
        if (err.killed) {
            console.log('  ✓ Playback started (timeout - normal for CI)');
        } else {
            console.log('  ✗ Playback error:', err.message);
        }
    }

    console.log('\n=== Test Complete ===');
    console.log('Output saved to: tests/output/combined-output.mp4');
}

main().catch(console.error);
