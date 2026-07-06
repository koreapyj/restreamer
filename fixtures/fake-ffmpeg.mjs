/*
 * restreamer - HLS restreaming daemon and switcher for tvheadend
 * Copyright (C) 2026 Yoonji Park
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/*
 * Hardware-free ffmpeg stand-in for the e2e test (test/e2e.test.ts spawns it
 * as `node fake-ffmpeg.mjs <real ffmpeg argv>`; the .sh twin is the Linux/CI
 * counterpart). Behavior mimicking what the supervisor observes of real
 * ffmpeg:
 *   - consumes stdin (the tsreadex output pipe),
 *   - derives outDir from the `<outDir>/%v/stream.m3u8` positional arg and
 *     keeps `<outDir>/1080p/stream.m3u8` fresh with a current
 *     EXT-X-PROGRAM-DATE-TIME (feeds the playlist watchdog),
 *   - emits `-progress pipe:3`-style blocks on fd 3 when it is open
 *     (feeds the progress stall watchdog),
 *   - exits 0 on stdin EOF (source aborted → flush → exit, like real ffmpeg)
 *     and on SIGTERM.
 */

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);

const mediaArg = argv.find((a) => a.includes('%v') && a.endsWith('stream.m3u8'));
if (!mediaArg) {
  process.stderr.write('fake-ffmpeg: no <outDir>/%v/stream.m3u8 output argument found\n');
  process.exit(2);
}
const variantDir = path.dirname(mediaArg).replace('%v', '1080p');
fs.mkdirSync(variantDir, { recursive: true });
const playlistPath = path.join(variantDir, 'stream.m3u8');

process.stderr.write(`fake-ffmpeg: started, writing ${playlistPath}\n`);

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  clearInterval(playlistTimer);
  if (progressTimer) clearInterval(progressTimer);
  process.stderr.write('fake-ffmpeg: exiting\n');
  process.exit(code);
}

let mediaSeq = 0;
function writePlaylist() {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:5',
    `#EXT-X-MEDIA-SEQUENCE:${mediaSeq}`,
    `#EXT-X-PROGRAM-DATE-TIME:${new Date().toISOString()}`,
    '#EXTINF:5.000,',
    `seg-${mediaSeq}.ts`,
    '',
  ];
  try {
    fs.writeFileSync(playlistPath, lines.join('\n'));
  } catch {
    // outDir cleaned up under us (session removal) — nothing to do
  }
  mediaSeq++;
}
writePlaylist();
const playlistTimer = setInterval(writePlaylist, 1000);

// -progress pipe:3 emulation: key=value blocks terminated by progress=continue
let progressTimer;
if (argv.includes('-progress')) {
  let outTimeUs = 0;
  progressTimer = setInterval(() => {
    outTimeUs += 300_000;
    const block = `bitrate=3000.0kbits/s\nspeed=1.0x\nout_time_us=${outTimeUs}\nprogress=continue\n`;
    try {
      fs.writeSync(3, block);
    } catch {
      // fd 3 not open / closed by the parent
    }
  }, 300);
}

// consume stdin; EOF means the source pipeline collapsed → flush and exit 0
process.stdin.resume();
process.stdin.on('end', () => finish(0));
process.stdin.on('close', () => finish(0));
process.stdin.on('error', () => finish(0));

process.on('SIGTERM', () => finish(0));
process.on('SIGINT', () => finish(0));
