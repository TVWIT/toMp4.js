import toMp4 from "@invintusmedia/tomp4";
import { writeFileSync } from "fs";

// Bitmovin test stream - DASH with fMP4 segments
// This stream has SEPARATE video and audio adaptation sets (common in DASH)
const baseUrl = "https://bitmovin-a.akamaihd.net/content/MI201109210084_1";
const videoQuality = "360_800000"; // 640x360

// ============================================================================
// Example 1: Video Only
// ============================================================================
console.log("\n=== Example 1: Video Only ===");
console.log("Downloading video segments...");

// Download video init segment
const videoInitResponse = await fetch(
  `${baseUrl}/video/${videoQuality}/dash/init.mp4`
);
const videoInit = new Uint8Array(await videoInitResponse.arrayBuffer());

// Download video data segments (4 seconds each)
const videoSegments = [];
for (let i = 0; i < 3; i++) {
  const response = await fetch(
    `${baseUrl}/video/${videoQuality}/dash/segment_${i}.m4s`
  );
  videoSegments.push(new Uint8Array(await response.arrayBuffer()));
}

// Stitch video into standard MP4
const videoMp4 = toMp4.stitchFmp4(videoSegments, { init: videoInit });
writeFileSync("stitched-video.mp4", videoMp4.data);
console.log(`Saved: stitched-video.mp4 (${videoMp4.sizeFormatted})`);

// ============================================================================
// Example 2: Audio Only
// ============================================================================
console.log("\n=== Example 2: Audio Only ===");
console.log("Downloading audio segments...");

// Download audio init segment
const audioInitResponse = await fetch(
  `${baseUrl}/audio/1_stereo_128000/dash/init.mp4`
);
const audioInit = new Uint8Array(await audioInitResponse.arrayBuffer());

// Download audio data segments
const audioSegments = [];
for (let i = 0; i < 3; i++) {
  const response = await fetch(
    `${baseUrl}/audio/1_stereo_128000/dash/segment_${i}.m4s`
  );
  audioSegments.push(new Uint8Array(await response.arrayBuffer()));
}

// Stitch audio into standard M4A
const audioMp4 = toMp4.stitchFmp4(audioSegments, { init: audioInit });
writeFileSync("stitched-audio.m4a", audioMp4.data);
console.log(`Saved: stitched-audio.m4a (${audioMp4.sizeFormatted})`);

// ============================================================================
// Summary
// ============================================================================
console.log("\n=== Summary ===");
console.log("Created:");
console.log("  - stitched-video.mp4: Video only (H.264)");
console.log("  - stitched-audio.m4a: Audio only (AAC)");

console.log("\n=== About Combined A/V ===");
console.log("This DASH stream has separate video and audio adaptation sets.");
console.log("To combine them into a single file, use ffmpeg:");
console.log("  ffmpeg -i stitched-video.mp4 -i stitched-audio.m4a -c copy combined.mp4");
console.log("\nNote: For streams where video+audio are already muxed together");
console.log("(like many live RTMP recordings), stitchFmp4 will include both tracks.");
