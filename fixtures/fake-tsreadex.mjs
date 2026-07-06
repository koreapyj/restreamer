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
 * Hardware-free tsreadex stand-in for the e2e test (spawned as
 * `node fake-tsreadex.mjs <real tsreadex argv>`; the .sh twin is the
 * Linux/CI counterpart). Pipes stdin → stdout like the real filter and exits
 * on EOF, SIGTERM, or a broken downstream pipe.
 */

process.stderr.write(`fake-tsreadex: started (argv: ${process.argv.slice(2).join(' ')})\n`);

process.stdin.pipe(process.stdout);
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdout.on('error', () => process.exit(0)); // downstream (ffmpeg) went away

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
