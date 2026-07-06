/*
 * Pure backoff policy: schedule progression, cap, jitter bounds, and the
 * source-http floor (tvh refusing a subscription retries no faster than 30s).
 */

import { describe, expect, it } from 'vitest';
import {
  BACKOFF_CAP_MS,
  BACKOFF_SCHEDULE_MS,
  SOURCE_HTTP_FLOOR_MS,
  backoffDelayMs,
} from '../src/supervise/backoff.js';

/** rng returning exactly 0.5 ⇒ jitter factor 1.0 */
const noJitter = () => 0.5;

describe('backoffDelayMs', () => {
  it('exports the schedule 2s,5s,10s,30s,60s,120s', () => {
    expect(BACKOFF_SCHEDULE_MS).toEqual([2_000, 5_000, 10_000, 30_000, 60_000, 120_000]);
    expect(BACKOFF_CAP_MS).toBe(300_000);
  });

  it('walks the schedule by consecutive failure count', () => {
    for (let i = 0; i < BACKOFF_SCHEDULE_MS.length; i++) {
      expect(backoffDelayMs(i + 1, 'crash', noJitter)).toBe(BACKOFF_SCHEDULE_MS[i]);
    }
  });

  it('caps at 300s beyond the schedule', () => {
    expect(backoffDelayMs(7, 'crash', noJitter)).toBe(BACKOFF_CAP_MS);
    expect(backoffDelayMs(50, 'crash', noJitter)).toBe(BACKOFF_CAP_MS);
  });

  it('treats 0 failures defensively as the first', () => {
    expect(backoffDelayMs(0, 'crash', noJitter)).toBe(2_000);
  });

  it('jitters ±20% via rng', () => {
    expect(backoffDelayMs(1, 'crash', () => 0)).toBe(1_600); // -20%
    expect(backoffDelayMs(1, 'crash', () => 1)).toBe(2_400); // +20%
    for (let i = 0; i < 200; i++) {
      const d = backoffDelayMs(3, 'crash', Math.random);
      expect(d).toBeGreaterThanOrEqual(8_000);
      expect(d).toBeLessThanOrEqual(12_000);
    }
  });

  it('applies a 30s floor for source-http (skips ahead in the schedule)', () => {
    expect(backoffDelayMs(1, 'source-http', noJitter)).toBe(SOURCE_HTTP_FLOOR_MS);
    expect(backoffDelayMs(2, 'source-http', noJitter)).toBe(SOURCE_HTTP_FLOOR_MS);
    expect(backoffDelayMs(3, 'source-http', noJitter)).toBe(SOURCE_HTTP_FLOOR_MS);
    // at and beyond the floor the normal schedule applies
    expect(backoffDelayMs(4, 'source-http', noJitter)).toBe(30_000);
    expect(backoffDelayMs(5, 'source-http', noJitter)).toBe(60_000);
    expect(backoffDelayMs(9, 'source-http', noJitter)).toBe(BACKOFF_CAP_MS);
  });

  it('jitter applies on top of the source-http floor', () => {
    expect(backoffDelayMs(1, 'source-http', () => 0)).toBe(24_000);
    expect(backoffDelayMs(1, 'source-http', () => 1)).toBe(36_000);
  });

  it('stall uses the normal schedule', () => {
    expect(backoffDelayMs(1, 'stall', noJitter)).toBe(2_000);
    expect(backoffDelayMs(4, 'stall', noJitter)).toBe(30_000);
  });
});
