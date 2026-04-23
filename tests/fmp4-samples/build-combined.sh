#!/usr/bin/env bash
# Rebuild combined.mp4 from the tracked DASH segments.
# combined.mp4 is gitignored (16+ MB); CI generates it from the
# tracked init_*/segment_* files before running tests.
#
# Requires ffmpeg.

set -euo pipefail

cd "$(dirname "$0")"

if [[ -f combined.mp4 ]]; then
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cat init_0.m4s segment_0_1.m4s segment_0_2.m4s segment_0_3.m4s segment_0_4.m4s > "$work/video.mp4"
cat init_1.m4s segment_1_1.m4s segment_1_2.m4s segment_1_3.m4s segment_1_4.m4s \
    segment_1_5.m4s segment_1_6.m4s segment_1_7.m4s segment_1_8.m4s > "$work/audio.m4a"

ffmpeg -y -loglevel error \
  -i "$work/video.mp4" -i "$work/audio.m4a" \
  -c copy \
  -movflags frag_keyframe+empty_moov+default_base_moof \
  combined.mp4
