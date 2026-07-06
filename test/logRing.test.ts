/*
 * LogRing — fixed-capacity ring buffer semantics.
 */

import { describe, expect, it } from 'vitest';
import { LogRing } from '../src/util/logRing.js';

function entry(n: number) {
  return { ts: `2026-07-06T00:00:${String(n).padStart(2, '0')}.000Z`, src: 'ffmpeg' as const, line: `line ${n}` };
}

describe('LogRing', () => {
  it('returns pushed entries in order', () => {
    const ring = new LogRing(5);
    ring.push(entry(1));
    ring.push(entry(2));
    ring.push(entry(3));
    expect(ring.size).toBe(3);
    expect(ring.tail(10).map((e) => e.line)).toEqual(['line 1', 'line 2', 'line 3']);
    expect(ring.tail(2).map((e) => e.line)).toEqual(['line 2', 'line 3']);
  });

  it('overwrites the oldest entries once full', () => {
    const ring = new LogRing(3);
    for (let i = 1; i <= 7; i++) ring.push(entry(i));
    expect(ring.size).toBe(3);
    expect(ring.tail(3).map((e) => e.line)).toEqual(['line 5', 'line 6', 'line 7']);
    expect(ring.tail(99)).toHaveLength(3);
  });

  it('handles zero capacity and non-positive tail sizes', () => {
    const ring = new LogRing(0);
    ring.push(entry(1));
    expect(ring.size).toBe(0);
    expect(ring.tail(5)).toEqual([]);

    const ring2 = new LogRing(2);
    ring2.push(entry(1));
    expect(ring2.tail(0)).toEqual([]);
    expect(ring2.tail(-1)).toEqual([]);
  });
});
