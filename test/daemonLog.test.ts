/*
 * Daemon-level logger wrapper: delegates to the base logger, records a
 * src:'daemon' ring entry per line, and serves tail + subscribe with the same
 * atomic replay/live semantics as the per-session rings.
 */

import { describe, expect, it } from 'vitest';
import { createDaemonLog } from '../src/util/daemonLog.js';
import type { LogEntry } from '../src/util/logRing.js';

function collector() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (m: string) => lines.push(`info:${m}`),
      warn: (m: string) => lines.push(`warn:${m}`),
      error: (m: string) => lines.push(`error:${m}`),
    },
  };
}

describe('createDaemonLog', () => {
  it('forwards every level to the base logger and captures src:daemon entries', () => {
    const base = collector();
    const log = createDaemonLog(base.logger, 10, () => 1_000);

    log.info('starting');
    log.warn('slow disk');
    log.error('boom');

    expect(base.lines).toEqual(['info:starting', 'warn:slow disk', 'error:boom']);
    const tail = log.logTail(10);
    expect(tail).toHaveLength(3);
    expect(tail.every((e) => e.src === 'daemon')).toBe(true);
    expect(tail.every((e) => e.ts === new Date(1_000).toISOString())).toBe(true);
    expect(tail.map((e) => e.line)).toEqual(['info: starting', 'warn: slow disk', 'error: boom']);
  });

  it('caps the ring at the configured capacity (oldest dropped)', () => {
    const log = createDaemonLog(collector().logger, 3);
    for (let i = 1; i <= 5; i++) log.info(`line ${i}`);
    expect(log.logTail(10).map((e) => e.line)).toEqual(['info: line 3', 'info: line 4', 'info: line 5']);
  });

  it('subscribeLog replays the tail atomically and then streams live lines', () => {
    const log = createDaemonLog(collector().logger, 10);
    log.info('before');

    const seen: LogEntry[] = [];
    let ended = false;
    const sub = log.subscribeLog(5, {
      onLine: (e) => seen.push(e),
      onEnd: () => {
        ended = true;
      },
    });

    expect(sub.live).toBe(true);
    expect(sub.tail.map((e) => e.line)).toEqual(['info: before']);

    log.warn('live 1');
    expect(seen.map((e) => e.line)).toEqual(['warn: live 1']);

    sub.unsubscribe();
    log.warn('after unsubscribe');
    expect(seen).toHaveLength(1);
    expect(ended).toBe(false);
  });

  it('endLogStreams fires onEnd on every subscriber exactly once', () => {
    const log = createDaemonLog(collector().logger, 10);
    let ends = 0;
    log.subscribeLog(0, { onLine: () => undefined, onEnd: () => ends++ });
    log.subscribeLog(0, { onLine: () => undefined, onEnd: () => ends++ });

    log.endLogStreams();
    expect(ends).toBe(2);
    log.endLogStreams(); // idempotent — set already cleared
    expect(ends).toBe(2);

    log.info('post-end'); // no listeners left; must not throw
    expect(log.logTail(1).map((e) => e.line)).toEqual(['info: post-end']);
  });
});
