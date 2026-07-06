/*
 * Session lifecycle state machine, driven with fake timers, fake children and
 * a fake source: start→running, progress parsing, exit classification and
 * backoff, watchdogs (progress stall / playlist lag / memory guard), graceful
 * stop escalation, health file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesiredSession } from '../src/contract/v1.js';
import { PAT_PROBE_MAX_BYTES, Session } from '../src/supervise/session.js';
import type { BuiltPipeline, SessionSettings } from '../src/supervise/types.js';
import { fakeSource, fakeSpawn, flush, memFs, sampleBuilt, sampleDesired, sampleSettings, silentLogger } from './support/fakes.js';
import { nullPacket, patStream } from './support/tsFixtures.js';

function makeSession(
  opts: {
    status?: number;
    settings?: Partial<SessionSettings>;
    desired?: Partial<DesiredSession>;
    pipeline?: Partial<BuiltPipeline>;
    readRssMb?: (pid: number) => Promise<number | null>;
  } = {},
) {
  const spawn = fakeSpawn();
  const source = fakeSource(opts.status ?? 200);
  const fs = memFs();
  const session = new Session({
    desired: sampleDesired(opts.desired),
    pipeline: { ...sampleBuilt('at-x'), ...opts.pipeline },
    configHash: 'hash-1',
    settings: sampleSettings(opts.settings),
    deps: {
      spawnImpl: spawn.impl,
      fetchImpl: source.fetchImpl,
      fs: fs.ops,
      rng: () => 0.5, // jitter factor exactly 1.0 → deterministic delays
      logger: silentLogger,
      readRssMb: opts.readRssMb ?? (async () => null),
    },
  });
  return { session, spawn, source, fs };
}

function retryInMs(session: Session): number {
  const at = session.status().nextRetryAt;
  if (!at) throw new Error('not in backoff');
  return Date.parse(at) - Date.now();
}

beforeEach(() => {
  // leave setImmediate real so flush() can drain stream callbacks
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Session start → running', () => {
  it('opens the source with the tvhc-restreamer User-Agent, spawns both children with the right stdio, and reaches running', async () => {
    const { session, spawn, source, fs } = makeSession();
    await session.start();

    expect(session.state).toBe('running');
    expect(source.calls[0]?.url).toContain('/stream/channel/');
    expect(source.calls[0]?.headers['User-Agent']).toBe('tvhc-restreamer/0.1.0 (at-x)');

    expect(spawn.calls[0]?.command).toBe('tsreadex');
    expect(spawn.calls[0]?.argv).toEqual(sampleBuilt('at-x').tsreadexArgv);
    expect(spawn.calls[0]?.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(spawn.calls[1]?.command).toBe('ffmpeg');
    expect(spawn.calls[1]?.stdio).toEqual(['pipe', 'ignore', 'pipe', 'pipe']);

    const st = session.status();
    expect(st.state).toBe('running');
    expect(st.tsreadexPid).toBe(spawn.tsreadex().pid);
    expect(st.ffmpegPid).toBe(spawn.ffmpeg().pid);
    expect(st.startedAt).toBe(new Date().toISOString());
    expect(fs.has('/media/at-x/health')).toBe(true);
  });

  it('parses -progress pipe:3 key=value blocks into status.progress', async () => {
    const { session, spawn } = makeSession();
    await session.start();

    spawn.ffmpeg().writeProgress({ bitrate: '2500.5kbits/s', speed: '1.05x', out_time_us: '2500000' });
    await flush();

    const progress = session.status().progress;
    expect(progress?.bitrateKbps).toBeCloseTo(2500.5);
    expect(progress?.speed).toBeCloseTo(1.05);
    expect(progress?.outTimeMs).toBe(2500);
    expect(progress?.updatedAt).toBe(new Date().toISOString());
  });

  it('captures stderr of both children into the log ring', async () => {
    const { session, spawn } = makeSession();
    await session.start();

    spawn.ffmpeg().writeStderr('frame dropped');
    spawn.tsreadex().writeStderr('pat rewritten');
    await flush();

    const lines = session.logRing.tail(10);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ src: 'ffmpeg', line: 'frame dropped' });
    expect(lines[1]).toMatchObject({ src: 'tsreadex', line: 'pat rewritten' });
  });

  it('never spawns anything for a disabled session and reports disabled', async () => {
    const { session, spawn, source } = makeSession({ desired: { enabled: false } });
    await session.start();
    expect(session.state).toBe('disabled');
    expect(session.status().state).toBe('disabled');
    expect(session.status().enabled).toBe(false);
    expect(spawn.calls).toHaveLength(0);
    expect(source.calls).toHaveLength(0);
  });
});

describe('exit classification and backoff', () => {
  it('healthy exit (≥60s with progress) resets the failure counter and restarts quickly', async () => {
    const { session, spawn } = makeSession({ settings: { stallTimeoutSec: 9_999 } });
    await session.start();
    spawn.ffmpeg().writeProgress();
    await flush();
    await vi.advanceTimersByTimeAsync(61_000);

    spawn.ffmpeg().exit(0);
    expect(session.state).toBe('backoff');
    const st = session.status();
    expect(st.lastExit?.class).toBe('healthy');
    expect(st.lastExit?.code).toBe(0);
    expect(st.consecutiveFailures).toBe(0);
    expect(retryInMs(session)).toBe(1_000);

    await vi.advanceTimersByTimeAsync(1_001);
    await flush();
    expect(session.state).toBe('running');
    expect(session.status().restarts).toBe(1);
    expect(spawn.children).toHaveLength(4); // a fresh generation
  });

  it('crashes walk the backoff schedule 2s → 5s → 10s', async () => {
    const { session, spawn } = makeSession();
    await session.start();

    spawn.ffmpeg().writeStderr('conversion failed!');
    await flush();
    spawn.ffmpeg().exit(1);
    expect(session.state).toBe('backoff');
    expect(session.status().lastExit?.class).toBe('crash');
    expect(session.status().lastExit?.code).toBe(1);
    expect(session.status().lastError).toBe('conversion failed!');
    expect(session.status().consecutiveFailures).toBe(1);
    expect(retryInMs(session)).toBe(2_000);

    await vi.advanceTimersByTimeAsync(2_001);
    await flush();
    expect(session.state).toBe('running');
    spawn.ffmpeg().exit(1);
    expect(session.status().consecutiveFailures).toBe(2);
    expect(retryInMs(session)).toBe(5_000);

    await vi.advanceTimersByTimeAsync(5_001);
    await flush();
    spawn.ffmpeg().exit(1);
    expect(session.status().consecutiveFailures).toBe(3);
    expect(retryInMs(session)).toBe(10_000);
  });

  it('classifies a non-2xx source response as source-http with the ≥30s floor', async () => {
    const { session, spawn } = makeSession({ status: 503 });
    await session.start();

    expect(session.state).toBe('backoff');
    const st = session.status();
    expect(st.lastExit?.class).toBe('source-http');
    expect(st.lastError).toContain('source HTTP 503');
    expect(st.consecutiveFailures).toBe(1);
    expect(retryInMs(session)).toBe(30_000);
    expect(spawn.calls).toHaveLength(0); // children never spawned
  });

  it('classifies the source body ending before first progress (instant EOF) as source-http', async () => {
    const { session, spawn, source } = makeSession();
    await session.start();

    source.body().end(); // tvh accepted then immediately dropped the subscription
    await flush();
    spawn.ffmpeg().exit(1);

    const st = session.status();
    expect(st.lastExit?.class).toBe('source-http');
    expect(st.consecutiveFailures).toBe(1);
    expect(retryInMs(session)).toBe(30_000);
  });

  it('does NOT classify a crash as source-http just because teardown aborts the source', async () => {
    const { session, spawn } = makeSession();
    await session.start();
    spawn.ffmpeg().exit(1); // crash aborts the source afterwards
    expect(session.status().lastExit?.class).toBe('crash');
  });

  it('restart() resets the backoff counter', async () => {
    const { session, spawn } = makeSession();
    await session.start();
    spawn.ffmpeg().exit(1);
    await vi.advanceTimersByTimeAsync(2_001);
    await flush();
    spawn.ffmpeg().exit(1);
    expect(session.status().consecutiveFailures).toBe(2);

    await session.restart();
    await flush();
    expect(session.state).toBe('running');
    expect(session.status().consecutiveFailures).toBe(0);
  });

  it('stop() during backoff cancels the retry — no zombie resurrection', async () => {
    const { session, spawn } = makeSession();
    await session.start();
    spawn.ffmpeg().exit(1);
    expect(session.state).toBe('backoff');

    await session.stop();
    expect(session.state).toBe('stopped');
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(session.state).toBe('stopped');
    expect(spawn.children).toHaveLength(2); // no new generation
  });
});

describe('watchdogs', () => {
  it('kills and classifies as stall when no progress arrives for stallTimeoutSec', async () => {
    const { session, spawn } = makeSession({ settings: { stallTimeoutSec: 30 } });
    await session.start();
    spawn.ffmpeg().writeProgress();
    await flush();

    const gen1Ffmpeg = spawn.ffmpeg();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(gen1Ffmpeg.killed).toContain('SIGTERM');
    expect(session.status().lastExit?.class).toBe('stall');
    expect(session.status().consecutiveFailures).toBe(1);
    expect(session.state).toBe('backoff');
  });

  it('escalates a stall kill to SIGKILL after 5s when SIGTERM is ignored', async () => {
    const { session, spawn } = makeSession({ settings: { stallTimeoutSec: 30 } });
    spawn.nextExitOnSigterm = false;
    await session.start();

    const ffmpeg = spawn.ffmpeg();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ffmpeg.killed).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ffmpeg.killed).toEqual(['SIGTERM', 'SIGKILL']);
    expect(session.status().lastExit?.class).toBe('stall');
    expect(session.status().lastExit?.signal).toBe('SIGKILL');
  });

  it('restarts with class stall when the playlist PDT lags beyond the threshold', async () => {
    // playlistStallSec null → derived: 3 × 5 + 15 = 30s
    const { session, spawn, fs } = makeSession({ settings: { stallTimeoutSec: 9_999 } });
    await session.start();
    spawn.ffmpeg().writeProgress();
    await flush();

    const stalePdt = new Date(Date.now() - 120_000).toISOString();
    fs.set(
      '/media/at-x/1080p/stream.m3u8',
      `#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:${stalePdt}\n20260706-120000.ts\n`,
    );
    await vi.advanceTimersByTimeAsync(15_000); // playlist watchdog tick

    const st = session.status();
    expect(st.lastExit?.class).toBe('stall');
    expect(st.playlistLagSec).toBeGreaterThan(30);
    expect(st.lastSegmentAt).toBe(stalePdt);
    expect(session.state).toBe('backoff');
  });

  it('leaves a fresh playlist alone and exposes lastSegmentAt/playlistLagSec', async () => {
    const { session, spawn, fs } = makeSession({ settings: { stallTimeoutSec: 9_999 } });
    await session.start();
    spawn.ffmpeg().writeProgress();
    await flush();

    const freshPdt = new Date(Date.now() + 14_000).toISOString(); // written just before the tick
    fs.set('/media/at-x/1080p/stream.m3u8', `#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:${freshPdt}\nseg.ts\n`);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(session.state).toBe('running');
    const st = session.status();
    expect(st.lastSegmentAt).toBe(freshPdt);
    expect(st.playlistLagSec).toBeLessThan(30);
  });

  it('falls back to playlist mtime when no PDT tag is present', async () => {
    const { session, spawn, fs } = makeSession({ settings: { stallTimeoutSec: 9_999 } });
    await session.start();
    spawn.ffmpeg().writeProgress();
    await flush();

    fs.set('/media/at-x/1080p/stream.m3u8', '#EXTM3U\nseg.ts\n', Date.now() - 120_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(session.status().lastExit?.class).toBe('stall');
  });

  it('memory guard: RSS over the limit triggers a graceful oom-guard restart with counter reset', async () => {
    const { session, spawn, source } = makeSession({
      settings: { stallTimeoutSec: 9_999, memoryLimitMb: 2_048, stopGraceSec: 10 },
      readRssMb: async () => 1_200, // ×2 pids = 2400 MB
    });
    await session.start();

    // prime a failure so we can observe the oom-guard reset
    spawn.ffmpeg().exit(1);
    expect(session.status().consecutiveFailures).toBe(1);
    await vi.advanceTimersByTimeAsync(2_001);
    await flush();
    expect(session.state).toBe('running');

    const ffmpeg = spawn.ffmpeg();
    await vi.advanceTimersByTimeAsync(10_000); // memory sample → trigger
    expect(session.status().memoryRssMb).toBe(2_400);
    expect(source.aborts).toBeGreaterThan(0); // graceful: source aborted first
    expect(ffmpeg.killed).toEqual([]); // …no signals yet
    await vi.advanceTimersByTimeAsync(10_000); // stopGraceSec → SIGTERM
    expect(ffmpeg.killed).toEqual(['SIGTERM']);

    const st = session.status();
    expect(st.lastExit?.class).toBe('oom-guard');
    expect(st.consecutiveFailures).toBe(0); // proactive restart is not a failure
    // quick restart (~1s), not the backoff schedule; ±few ms of fake-timer
    // drift from the async interval callback is fine
    expect(retryInMs(session)).toBeGreaterThan(900);
    expect(retryInMs(session)).toBeLessThanOrEqual(1_000);
  });

  it('memory guard stays quiet under the limit', async () => {
    const { session, spawn } = makeSession({
      settings: { stallTimeoutSec: 9_999, memoryLimitMb: 2_048 },
      readRssMb: async () => 500,
    });
    await session.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(session.state).toBe('running');
    expect(session.status().memoryRssMb).toBe(1_000);
    expect(spawn.ffmpeg().killed).toEqual([]);
  });
});

describe('graceful stop', () => {
  it('escalates abort → (grace) → SIGTERM → (+5s) → SIGKILL in order', async () => {
    const { session, spawn, source, fs } = makeSession({ settings: { stopGraceSec: 10 } });
    spawn.nextExitOnSigterm = false;
    await session.start();
    expect(fs.has('/media/at-x/health')).toBe(true);

    const stopped = session.stop();
    await flush();
    expect(session.state).toBe('stopping');
    expect(source.aborts).toBe(1); // source aborted immediately
    expect(spawn.ffmpeg().killed).toEqual([]);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(spawn.ffmpeg().killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawn.ffmpeg().killed).toEqual(['SIGTERM']);
    expect(spawn.tsreadex().killed).toEqual(['SIGTERM']);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(spawn.ffmpeg().killed).toEqual(['SIGTERM', 'SIGKILL']);
    await stopped;
    expect(session.state).toBe('stopped');
    expect(fs.has('/media/at-x/health')).toBe(false);
  });

  it('sends no signals at all when the EOF cascade exits the children within the grace period', async () => {
    const { session, spawn } = makeSession({ settings: { stopGraceSec: 10 } });
    await session.start();

    const stopped = session.stop();
    await flush();
    // EOF cascade: tsreadex then ffmpeg exit on their own
    spawn.tsreadex().exit(0);
    spawn.ffmpeg().exit(0);
    await stopped;

    expect(session.state).toBe('stopped');
    expect(spawn.tsreadex().killed).toEqual([]);
    expect(spawn.ffmpeg().killed).toEqual([]);
    expect(session.status().nextRetryAt).toBeUndefined(); // intentional stop → no reschedule
  });
});

describe('PAT probe (needsProgramNumber)', () => {
  // argv the builder produces when programNumber is absent — no -n
  const PROBED_ARGV = ['-a', '13', '-b', '7', '-c', '5', '-u', '2', '-'];
  const NO_PAT_ERROR =
    'no PAT found in the first 2MiB/10s of the source — cannot derive a program number; set a manual programNumber override';

  function makeProbeSession() {
    return makeSession({ pipeline: { tsreadexArgv: PROBED_ARGV, needsProgramNumber: true } });
  }

  it('spawns tsreadex with the detected -n prepended and forwards the probed bytes before the live ones', async () => {
    const { session, spawn, source } = makeProbeSession();
    const starting = session.start();
    await flush();
    expect(spawn.calls).toHaveLength(0); // probing — nothing spawned yet
    expect(session.status().state).toBe('starting');
    expect(session.status().detectedProgramNumber).toBeUndefined();

    const probeBytes = patStream([{ programNumber: 1064, pmtPid: 0x1f0 }]);
    source.body().write(probeBytes);
    await starting;

    expect(session.state).toBe('running');
    expect(spawn.calls[0]?.command).toBe('tsreadex');
    expect(spawn.calls[0]?.argv).toEqual(['-n', '1064', ...PROBED_ARGV]);
    expect(session.status().detectedProgramNumber).toBe(1064);

    // bytes consumed by the probe reach tsreadex first, then the live stream
    source.body().write(Buffer.from('LIVE-BYTES'));
    await flush();
    const stdin = spawn.tsreadex().stdinBytes();
    expect(stdin.equals(Buffer.concat([probeBytes, Buffer.from('LIVE-BYTES')]))).toBe(true);

    // detected value is kept across restarts until a new probe result
    spawn.ffmpeg().exit(1);
    expect(session.state).toBe('backoff');
    expect(session.status().detectedProgramNumber).toBe(1064);
  });

  it('probe timeout: generation dies as crash with the no-PAT lastError and retries via backoff', async () => {
    const { session, spawn, source } = makeProbeSession();
    const starting = session.start();
    await flush();
    source.body().write(nullPacket()); // bytes flow, but no PAT
    await vi.advanceTimersByTimeAsync(10_000);
    await starting;

    expect(session.state).toBe('backoff');
    expect(spawn.calls).toHaveLength(0); // children never spawned
    const st = session.status();
    expect(st.lastExit?.class).toBe('crash');
    expect(st.lastError).toBe(NO_PAT_ERROR);
    expect(st.consecutiveFailures).toBe(1);
    expect(retryInMs(session)).toBe(2_000); // normal crash backoff schedule
    expect(source.aborts).toBe(1); // generation torn down

    await vi.advanceTimersByTimeAsync(2_001);
    await flush();
    expect(source.calls).toHaveLength(2); // fresh generation, probing again
    expect(session.status().state).toBe('starting');
  });

  it('probe byte bound: 2MiB without a PAT fails the generation as crash', async () => {
    const { session, spawn, source } = makeProbeSession();
    const starting = session.start();
    await flush();
    source.body().write(Buffer.alloc(PAT_PROBE_MAX_BYTES, 0x00));
    await starting;

    expect(session.state).toBe('backoff');
    expect(spawn.calls).toHaveLength(0);
    expect(session.status().lastExit?.class).toBe('crash');
    expect(session.status().lastError).toBe(NO_PAT_ERROR);
  });

  it('explicit programNumber: start() completes without any source bytes — no probe attached', async () => {
    const { session, spawn } = makeSession(); // default pipeline: needsProgramNumber false
    await session.start(); // would hang on the probe if one were attached
    expect(session.state).toBe('running');
    expect(spawn.calls[0]?.argv).toEqual(sampleBuilt('at-x').tsreadexArgv);
    expect(session.status().detectedProgramNumber).toBeUndefined();
  });

  it('stop() during the probe aborts cleanly — no children, no error, no restart', async () => {
    const { session, spawn, source } = makeProbeSession();
    const starting = session.start();
    await flush();

    const stopping = session.stop();
    await starting;
    await stopping;

    expect(session.state).toBe('stopped');
    expect(spawn.calls).toHaveLength(0);
    expect(source.aborts).toBe(1);
    expect(session.status().nextRetryAt).toBeUndefined();
    expect(session.status().lastError).toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000); // probe timeout + any retry window
    await flush();
    expect(source.calls).toHaveLength(1); // never resurrected
    expect(session.state).toBe('stopped');
  });
});

describe('health file', () => {
  it('is created on running, rewritten every 5s as an ISO-8601 UTC line, and removed on exit', async () => {
    const { session, spawn, fs } = makeSession({ settings: { stallTimeoutSec: 9_999 } });
    await session.start();

    const first = fs.files.get('/media/at-x/health');
    expect(first?.trim()).toBe(new Date().toISOString());

    await vi.advanceTimersByTimeAsync(5_000);
    const second = fs.files.get('/media/at-x/health');
    expect(second?.trim()).toBe(new Date().toISOString());
    expect(second).not.toBe(first);

    spawn.ffmpeg().exit(1); // unexpected exit also removes it
    expect(fs.has('/media/at-x/health')).toBe(false);
  });
});
