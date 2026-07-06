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
 * Pure backoff policy. `healthy` and `oom-guard` exits are NOT failures — the
 * caller resets the consecutive-failure counter and performs a quick restart
 * instead of consulting this schedule.
 */

import type { ExitClass } from '../contract/v1.js';

/** Delay for the 1st, 2nd, … consecutive failure; beyond the schedule the cap applies. */
export const BACKOFF_SCHEDULE_MS: readonly number[] = [2_000, 5_000, 10_000, 30_000, 60_000, 120_000];

export const BACKOFF_CAP_MS = 300_000;

/**
 * tvheadend refusing the subscription (`source-http`) is not going to resolve
 * in seconds — skip ahead in the schedule so retries start at ≥30s.
 */
export const SOURCE_HTTP_FLOOR_MS = 30_000;

/** ±20% jitter */
export const JITTER_FRACTION = 0.2;

/**
 * Delay before the next spawn attempt after the `consecutiveFailures`-th
 * consecutive failure (1-based; 0 is treated as 1 defensively) of class
 * `cls`, jittered ±20% via `rng` (uniform in [0,1); 0.5 ⇒ no jitter).
 */
export function backoffDelayMs(consecutiveFailures: number, cls: ExitClass, rng: () => number): number {
  const idx = Math.max(0, consecutiveFailures - 1);
  let base = idx < BACKOFF_SCHEDULE_MS.length ? (BACKOFF_SCHEDULE_MS[idx] as number) : BACKOFF_CAP_MS;
  if (cls === 'source-http' && base < SOURCE_HTTP_FLOOR_MS) base = SOURCE_HTTP_FLOOR_MS;
  const jitter = 1 + (rng() * 2 - 1) * JITTER_FRACTION;
  return Math.round(base * jitter);
}
