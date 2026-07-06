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

/** One captured log line from a session's children (or its source stream). */
export interface LogEntry {
  /** ISO 8601 */
  ts: string;
  src: 'ffmpeg' | 'tsreadex' | 'source';
  line: string;
}

/**
 * Fixed-capacity ring buffer of log lines. Push is O(1); once full, the
 * oldest entry is overwritten. `tail(n)` returns the newest `n` entries in
 * chronological order.
 */
export class LogRing {
  private readonly buf: (LogEntry | undefined)[];
  /** next write position */
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.buf = new Array<LogEntry | undefined>(Math.max(0, capacity));
  }

  get size(): number {
    return this.count;
  }

  push(entry: LogEntry): void {
    if (this.capacity <= 0) return;
    this.buf[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  tail(n: number): LogEntry[] {
    const take = Math.max(0, Math.min(n, this.count));
    const out: LogEntry[] = [];
    for (let i = 0; i < take; i++) {
      const idx = (this.head - take + i + 2 * this.capacity) % this.capacity;
      const entry = this.buf[idx];
      if (entry !== undefined) out.push(entry);
    }
    return out;
  }
}
