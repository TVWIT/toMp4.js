// tests/analyze-media.test.js
import { RemoteMp4 } from '@invintusmedia/tomp4';

const URL =
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';

// small format helpers
const round2 = n => (Number.isFinite(n) ? Number(n.toFixed(2)) : null);
const toMB = bytes => round2(bytes / 1024 / 1024);

async function analyze() {
    try {
        const t0 = Date.now();
        const src = await RemoteMp4.fromUrl(URL);
        const parsedInSec = round2((Date.now() - t0) / 1000);

        const {
            fileSize,
            duration,
            hasBframes,
            videoTrack,
            audioTrack,
            videoSamples = [],
            audioSamples = [],
            width,
            height,
            segments = [],
        } = src;

        // booleans and basics
        const hasVideo = !!videoTrack || videoSamples.length > 0;
        const hasAudio = !!audioTrack || audioSamples.length > 0;
        const bitrateMbps = round2((fileSize * 8) / duration / 1_000_000);

        // video stats
        const keyframes = videoSamples.filter(s => s.isKeyframe);
        const avgFps = duration ? round2(videoSamples.length / duration) : null;
        const avgGopSec =
            keyframes.length > 1 && duration ? round2(duration / keyframes.length) : null;
        const first5Keyframes = keyframes.slice(0, 5).map(k => round2(k.time));

        // segment preview (keep output small)
        const first3Segments = segments.slice(0, 3).map(s => ({
            index: s.index,
            startTime: round2(s.startTime),
            endTime: round2(s.endTime),
            duration: round2(s.duration),
        }));

        const output = {
            target: URL,
            parsedInSec,
            info: {
                fileSizeBytes: fileSize,
                fileSizeMB: toMB(fileSize),
                durationSec: round2(duration),
                bitrateMbps,
                hasVideo,
                hasAudio,
                hasBframes: !!hasBframes,
            },
            video: hasVideo
                ? {
                    width,
                    height,
                    sampleCount: videoSamples.length,
                    avgFps,
                    keyframeCount: keyframes.length,
                    avgGopSec,
                    first5Keyframes,
                }
                : null,
            audio:
                hasAudio && audioTrack
                    ? {
                        sampleRate: audioTrack.audioConfig?.sampleRate ?? null,
                        channels: audioTrack.audioConfig?.channels ?? null,
                        sampleCount: audioSamples.length,
                        avgSampleMs:
                            audioSamples.length && duration
                                ? round2((duration / audioSamples.length) * 1000)
                                : null,
                    }
                    : null,
            segmentation: {
                totalSegments: segments.length,
                first3Segments,
            },
        };

        console.log(JSON.stringify(output, null, 2));
    } catch (err) {
        console.log(
            JSON.stringify(
                { error: true, message: err?.message ?? 'Unknown error', stack: err?.stack ?? null },
                null,
                2
            )
        );
    }
}

analyze();