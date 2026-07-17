/*
 * Route-level tests for GET /v1/log (tail) and GET /v1/log/stream (SSE):
 * real Supervisor + real Fastify server on an ephemeral port, the daemon
 * logger shared between them so supervisor/api lines land in the ring —
 * and session ffmpeg stderr provably does not. Also covers the /v1/status
 * observability additions (pendingRemovals, lastAppliedAt,
 * persistedStateCorrupt) over the wire.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../../src/api/server.js';
import type { DaemonConfig } from '../../src/config.js';
import type { DesiredSession, DesiredState, StatusResponse } from '../../src/contract/v1.js';
import { SourcesCatalog } from '../../src/sources/catalog.js';
import { DesiredStore } from '../../src/state/desiredStore.js';
import { Session } from '../../src/supervise/session.js';
import { Supervisor } from '../../src/supervise/supervisor.js';
import type { SessionFactory } from '../../src/supervise/types.js';
import { createDaemonLog, type DaemonLog } from '../../src/util/daemonLog.js';
import type { LogEntry } from '../../src/util/logRing.js';
import {
  fakeSource,
  fakeSpawn,
  memFs,
  sampleBuilt,
  sampleDesired,
  sampleSettings,
  silentLogger,
  type FakeSpawn,
} from '../support/fakes.js';

function testConfig(): DaemonConfig {
  return {
    listen: { host: '127.0.0.1', port: 0 },
    serveDir: '/media',
    stateFile: '/unused/desired.json',
    tvhBaseUrl: 'http://127.0.0.1:9981',
    defaultWeight: 100,
    ffmpegPath: 'ffmpeg',
    tsreadexPath: 'tsreadex',
    capabilities: ['qsv', 'opencl'],
    logLines: 100,
    stallTimeoutSec: 30,
    playlistStallSec: null,
    memoryLimitMb: 2048,
    stopGraceSec: 10,
    cleanupOnRemove: false,
    cleanupDelaySec: 0,
  };
}

function sess(name: string, overrides: Partial<DesiredSession> = {}): DesiredSession {
  return sampleDesired({ name, ...overrides });
}

function doc(revision: string, sessions: DesiredSession[]): DesiredState {
  return { apiVersion: 1, revision, sessions };
}

interface SseFrame {
  event: string;
  data: string;
}

/** incremental SSE reader over a fetch Response body */
function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buf = '';
  let done = false;
  void (async () => {
    for (;;) {
      const { done: d, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (d) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice('event: '.length);
          else if (line.startsWith('data: ')) data += line.slice('data: '.length);
          // retry:/comment lines are ignored
        }
        if (event !== 'message' || data !== '') frames.push({ event, data });
      }
    }
    done = true;
  })();
  return {
    frames,
    isDone: () => done,
    cancel: () => reader.cancel().catch(() => undefined),
    async waitFor(pred: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!pred()) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${what}; frames so far: ${JSON.stringify(frames)}`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

describe('GET /v1/log and /v1/log/stream (daemon log)', () => {
  let dir: string;
  let daemonLog: DaemonLog;
  let supervisor: Supervisor;
  let catalog: SourcesCatalog;
  let server: FastifyInstance;
  let base: string;
  let rigs: Map<string, { spawn: FakeSpawn }>;

  const factory: SessionFactory = (init) => {
    const spawn = fakeSpawn();
    const source = fakeSource(200);
    const fs = memFs();
    rigs.set(init.desired.name, { spawn });
    return new Session({
      desired: init.desired,
      pipeline: init.pipeline,
      configHash: init.configHash,
      // stall watchdog effectively off (real timers); instant SIGTERM on stop
      settings: sampleSettings({ stallTimeoutSec: 9_999, stopGraceSec: 0 }),
      deps: {
        spawnImpl: spawn.impl,
        fetchImpl: source.fetchImpl,
        fs: fs.ops,
        rng: () => 0.5,
        logger: daemonLog, // session logs *about* itself via the daemon logger
        readRssMb: async () => null,
      },
    });
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'restreamer-daemonlog-'));
    rigs = new Map();
    daemonLog = createDaemonLog(silentLogger, 100);
    supervisor = new Supervisor({
      buildPipeline: (session) => sampleBuilt(session.name),
      store: new DesiredStore(join(dir, 'desired.json'), silentLogger),
      config: testConfig(),
      logger: daemonLog,
      sessionFactory: factory,
      fs: { rm: async () => undefined, readdir: async () => [] },
    });
    catalog = new SourcesCatalog(null, { logger: daemonLog });
    await catalog.start();
    server = createServer({ supervisor, config: testConfig(), catalog, logger: daemonLog, daemonLog });
    await server.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    supervisor.endAllLogStreams();
    daemonLog.endLogStreams();
    await server.close();
    await supervisor.stopAll();
    catalog.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the daemon ring tail as {lines}: supervisor lines in, session stderr out', async () => {
    await supervisor.applyDesired(doc('r1', [sess('s1')]));
    rigs.get('s1')?.spawn.ffmpeg().writeStderr('frame=1 fps=25 SESSION-NOISE');
    await supervisor.applyDesired(doc('r2', [])); // "session s1 removed — stopping"

    const res = await fetch(`${base}/v1/log`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: LogEntry[] };
    expect(body.lines.length).toBeGreaterThan(0);
    expect(body.lines.every((e) => e.src === 'daemon')).toBe(true);
    expect(body.lines.some((e) => e.line.includes('session s1 removed'))).toBe(true);
    expect(body.lines.some((e) => e.line.includes('SESSION-NOISE'))).toBe(false);
  });

  it('honours lines=N and rejects a bad lines parameter', async () => {
    daemonLog.info('one');
    daemonLog.info('two');
    daemonLog.info('three');

    const res = await fetch(`${base}/v1/log?lines=2`);
    const body = (await res.json()) as { lines: LogEntry[] };
    expect(body.lines.map((e) => e.line)).toEqual(['info: two', 'info: three']);

    expect((await fetch(`${base}/v1/log?lines=-1`)).status).toBe(400);
    expect((await fetch(`${base}/v1/log?lines=abc`)).status).toBe(400);
  });

  it('streams the ring tail then live lines over SSE; endLogStreams sends event:end', async () => {
    daemonLog.info('pre-connect line');

    const res = await fetch(`${base}/v1/log/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const s = sseReader(res);
    await s.waitFor(() => s.frames.some((f) => f.data.includes('pre-connect line')), 'tail replay');

    daemonLog.warn('live line');
    await s.waitFor(() => s.frames.some((f) => f.data.includes('live line')), 'live line');
    expect(s.frames.every((f) => f.event === 'log')).toBe(true);

    daemonLog.endLogStreams();
    await s.waitFor(() => s.frames.some((f) => f.event === 'end'), 'end frame');
    await s.waitFor(() => s.isDone(), 'stream closed');
  });

  it('daemon SSE never carries session stderr, even while a session stream would', async () => {
    await supervisor.applyDesired(doc('r1', [sess('s1')]));
    const s = sseReader(await fetch(`${base}/v1/log/stream`));

    rigs.get('s1')?.spawn.ffmpeg().writeStderr('SESSION-ONLY-LINE');
    daemonLog.info('daemon marker after stderr');
    await s.waitFor(() => s.frames.some((f) => f.data.includes('daemon marker after stderr')), 'daemon marker');
    expect(s.frames.some((f) => f.data.includes('SESSION-ONLY-LINE'))).toBe(false);
    s.cancel();
  });

  it('GET /v1/status carries pendingRemovals, lastAppliedAt and persistedStateCorrupt', async () => {
    await supervisor.applyDesired(doc('r1', [sess('s1')]));
    const status = (await (await fetch(`${base}/v1/status`)).json()) as StatusResponse;
    expect(status.pendingRemovals).toEqual([]);
    expect(typeof status.lastAppliedAt).toBe('string');
    expect(status.persistedStateCorrupt).toBe(false);
  });
});
