#!/usr/bin/env bash
# Compose the demo videos recorded by record.ts (ffmpeg: no drawtext needed, captions are a recorded pane).
#
#   compose.sh story <out.mp4> <title.png> <app.webm> <appOffset> <world.webm> <worldOffset> <cap.webm> <capOffset> <seconds>
#       2.5 s title card, then [app 292x632 | world 988x632] over the 1280x88 caption strip = 1280x720.
#       Offsets (s) trim each recording to the common start.
#   compose.sh join <out.mp4> <a.mp4> <b.mp4>...
#       Concatenate stories (same encoding, stream copy).
set -euo pipefail
FFMPEG="${FFMPEG:-$(command -v ffmpeg || echo /opt/homebrew/bin/ffmpeg)}"
mode="$1"; shift

case "$mode" in
  story)
    out="$1" title="$2" app="$3" ao="$4" world="$5" wo="$6" cap="$7" co="$8" secs="$9"
    "$FFMPEG" -hide_banner -loglevel error -y \
      -loop 1 -framerate 25 -t 2.5 -i "$title" \
      -ss "$ao" -t "$secs" -i "$app" \
      -ss "$wo" -t "$secs" -i "$world" \
      -ss "$co" -t "$secs" -i "$cap" \
      -filter_complex "\
[0:v]scale=1280:720,setsar=1,fps=25,format=yuv420p[t];\
[1:v]scale=292:632,setsar=1,fps=25,tpad=stop_mode=clone:stop_duration=5[a];\
[2:v]scale=988:632,setsar=1,fps=25,tpad=stop_mode=clone:stop_duration=5[w];\
[3:v]scale=1280:88,setsar=1,fps=25,tpad=stop_mode=clone:stop_duration=5[c];\
[a][w]hstack=inputs=2:shortest=1[top];[top][c]vstack=inputs=2:shortest=1,trim=duration=${secs},format=yuv420p[m];\
[t][m]concat=n=2:v=1:a=0[out]" \
      -map "[out]" -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -movflags +faststart "$out"
    ;;
  join)
    out="$1"; shift
    list="$(mktemp)"
    for f in "$@"; do printf "file '%s'\n" "$f" >> "$list"; done
    "$FFMPEG" -hide_banner -loglevel error -y -f concat -safe 0 -i "$list" -c copy -movflags +faststart "$out"
    rm -f "$list"
    ;;
  *) echo "usage: compose.sh story|join ..." >&2; exit 2 ;;
esac
echo "wrote $out"
