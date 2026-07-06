#!/bin/sh
# restreamer - HLS restreaming daemon and switcher for tvheadend
# Copyright (C) 2026 Yoonji Park
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or any
# later version. This program is distributed WITHOUT ANY WARRANTY; see
# <https://www.gnu.org/licenses/> for details.
#
# POSIX-sh counterpart of fake-ffmpeg.mjs for Linux CI / manual smoke runs.
# The vitest e2e uses the .mjs version so it also runs on Windows dev
# machines. Same observable behavior: consume stdin, keep
# <outDir>/1080p/stream.m3u8 fresh with a current EXT-X-PROGRAM-DATE-TIME,
# emit -progress blocks on fd 3 when open, exit 0 on stdin EOF or SIGTERM.

media=''
progress=0
for a in "$@"; do
  case "$a" in
    */%v/stream.m3u8) media="$a" ;;
    -progress) progress=1 ;;
  esac
done
if [ -z "$media" ]; then
  echo 'fake-ffmpeg: no <outDir>/%v/stream.m3u8 output argument found' >&2
  exit 2
fi
dir=$(dirname "$media" | sed 's|%v|1080p|')
mkdir -p "$dir"
echo "fake-ffmpeg: started, writing $dir/stream.m3u8" >&2

# fd 3 only usable when the parent opened it as a pipe
if [ "$progress" = 1 ] && ! { true >&3; } 2>/dev/null; then
  progress=0
fi

trap 'echo "fake-ffmpeg: exiting" >&2; exit 0' TERM INT

# consume stdin; its exit signals source EOF. 0<&0: POSIX gives background
# commands /dev/null as stdin unless explicitly redirected.
cat 0<&0 >/dev/null &
CAT=$!

seq=0
out_time=0
while kill -0 "$CAT" 2>/dev/null; do
  now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  {
    echo '#EXTM3U'
    echo '#EXT-X-VERSION:3'
    echo '#EXT-X-TARGETDURATION:5'
    echo "#EXT-X-MEDIA-SEQUENCE:$seq"
    echo "#EXT-X-PROGRAM-DATE-TIME:$now"
    echo '#EXTINF:5.000,'
    echo "seg-$seq.ts"
  } >"$dir/stream.m3u8"
  seq=$((seq + 1))
  if [ "$progress" = 1 ]; then
    out_time=$((out_time + 1000000))
    printf 'bitrate=3000.0kbits/s\nspeed=1.0x\nout_time_us=%s\nprogress=continue\n' "$out_time" >&3
  fi
  sleep 1
done
echo 'fake-ffmpeg: exiting' >&2
exit 0
