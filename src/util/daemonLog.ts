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
 * Daemon-level logger: a Logger that forwards every line to a base logger
 * (console in production) AND captures it in a LogRing, so the daemon's own
 * activity is inspectable over the API (GET /v1/log, GET /v1/log/stream)
 * with the same tail + subscribe semantics as the per-session stderr rings.
 * Session ffmpeg/tsreadex output does NOT pass through here — it goes to the
 * per-session rings; only lines *about* sessions (via the injected Logger)
 * land in this ring.
 */

import type { Logger, LogSubscriber, LogSubscription } from '../supervise/types.js';
import { type LogEntry, LogRing } from './logRing.js';

export interface DaemonLog extends Logger {
  /** newest `lines` ring entries, chronological (GET /v1/log) */
  logTail(lines: number): LogEntry[];
  /** atomic tail snapshot + live-line subscription (GET /v1/log/stream) */
  subscribeLog(tailLines: number, sub: LogSubscriber): LogSubscription;
  /** fire onEnd() on all subscribers — called on shutdown BEFORE the HTTP server closes */
  endLogStreams(): void;
}

/**
 * Wrap `base` so info/warn/error both delegate to it and record a
 * `src: 'daemon'` LogEntry in a ring of `capacity` lines.
 */
export function createDaemonLog(base: Logger, capacity: number, now: () => number = Date.now): DaemonLog {
  const ring = new LogRing(capacity);
  const listeners = new Set<LogSubscriber>();

  const record = (level: 'info' | 'warn' | 'error', msg: string): void => {
    base[level](msg);
    const entry: LogEntry = { ts: new Date(now()).toISOString(), src: 'daemon', line: `${level}: ${msg}` };
    ring.push(entry);
    for (const sub of listeners) sub.onLine(entry);
  };

  return {
    info: (msg) => record('info', msg),
    warn: (msg) => record('warn', msg),
    error: (msg) => record('error', msg),
    logTail: (lines) => ring.tail(lines),
    // atomic tail + registration (no await in between): no line can be
    // duplicated or dropped across the replay/live boundary
    subscribeLog: (tailLines, sub) => {
      const tail = ring.tail(tailLines);
      listeners.add(sub);
      return {
        tail,
        live: true,
        unsubscribe: () => {
          listeners.delete(sub);
        },
      };
    },
    endLogStreams: () => {
      for (const sub of listeners) sub.onEnd();
      listeners.clear();
    },
  };
}
