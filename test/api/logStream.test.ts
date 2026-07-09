/*
 * Route-level tests for GET /v1/sessions/:name/log/stream (SSE) and
 * POST /v1/sessions/:name/restarts/reset: real Supervisor + real Fastify
 * server on an ephemeral port, real Session objects wired to fakes
 * (fakeSpawn / fakeSource / memFs) so stderr lines can be injected and the
 * stream observed over a real HTTP connection. Real timers throughout —
 * these tests exercise wiring, not timing.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../../src/api/server.js';
import type { DaemonConfig } from '../../src/config.js';
import type { DesiredSession, DesiredState } from '../../src/contract/v1.js';
import { SourcesCatalog } from '../../src/sources/catalog.js';
import { DesiredStore } from '../../src/state/desiredStore.js';
import { Session } from '../../src/supervise/session.js';
import { Supervisor } from '../../src/supervise/supervisor.js';
import type { SessionFactory } from '../../src/supervise/types.js';
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

describe('GET /v1/sessions/:name/log/stream', () => {
  let dir: string;
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
        logger: silentLogger,
        readRssMb: async () => null,
      },
    });
  };

  function rig(name: string): { spawn: FakeSpawn } {
    const r = rigs.get(name);
    if (!r) throw new Error(`no rig for session ${name}`);
    return r;
  }

  function connect(name: string): Promise<Response> {
    return fetch(`${base}/v1/sessions/${name}/log/stream`);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'restreamer-logstream-'));
    rigs = new Map();
    supervisor = new Supervisor({
      buildPipeline: (session) => {
        if (session.name.startsWith('unbuildable')) throw new Error('template rejected params');
        return sampleBuilt(session.name);
      },
      store: new DesiredStore(join(dir, 'desired.json'), silentLogger),
      config: testConfig(),
      logger: silentLogger,
      sessionFactory: factory,
      fs: { rm: async () => undefined },
    });
    catalog = new SourcesCatalog(null, { logger: silentLogger });
    await catalog.start();
    server = createServer({ supervisor, config: testConfig(), catalog, logger: silentLogger });
    await server.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    supervisor.endAllLogStreams();
    await server.close();
    await supervisor.stopAll();
    catalog.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('404s for unknown sessions with a JSON error, not an SSE response', async () => {
    const res = await fetch(`${base}/v1/sessions/nope/log/stream`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ error: 'unknown session: nope' });
  });

  it('400s on an invalid lines parameter', async () => {
    await supervisor.applyDesired(doc('r1', [sess('s1')]));
    const res = await fetch(`${base}/v1/sessions/s1/log/stream?lines=-3`);
    expect(res.status).toBe(400);
  });

  it('replays the ring tail then streams live lines with no duplicates or gaps', async () => {
    await supervisor.applyDesired(doc('r1', [sess('s1')]));
    rig('s1').spawn.ffmpeg().writeStderr('early line');
    await new Promise((r) => setImmediate(r)); // let the stderr line land in the ring

    const res = await connect('s1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const s = sseReader(res);
    await s.waitFor(() => s.frames.length >= 1, 'replayed tail');
    expect(s.frames[0]!.event).toBe('log');
    expect(JSON.parse(s.frames[0]!.data)).toMatchObject({ src: 'ffmpeg', line: 'early line' });

    rig('s1').spawn.ffmpeg().writeStderr('live line');
    rig('s1').spawn.tsreadex().writeStderr('from tsreadex');
    await s.waitFor(() => s.frames.length >= 3, 'live lines');
    expect(JSON.parse(s.frames[1]!.data)).toMatchObject({ src: 'ffmpeg', line: 'live line' });
    expect(JSON.parse(s.frames[2]!.data)).toMatchObject({ src: 'tsreadex', line: 'from tsreadex' });
    const earlies = s.frames.filter((f) => f.data !== '' && (JSON.parse(f.data) as { line?: string }).line === 'early line');
    expect(earlies).toHaveLength(1); // replay never duplicated
    s.cancel();
  });

  it('keeps the stream attached across a kill+respawn restart of the same session', async () => {
    await supervisor.applyDesired(doc('r1', [sess('s1')]));
    const s = sseReader(await connect('s1'));

    await supervisor.restartSession('s1');
    rig('s1').spawn.ffmpeg().writeStderr('new generation speaking');
    await s.waitFor(
      () => s.frames.some((f) => f.data.includes('new generation speaking')),
      'line from the post-restart generation',
    );
    expect(s.frames.every((f) => f.event === 'log')).toBe(true); // no end — same Session object
    s.cancel();
  });

  it('sends event:end and closes when the session is removed from the desired doc', async () => {
    await supervisor.applyDesired(doc('r1', [sess('s1')]));
    const s = sseReader(await connect('s1'));

    await supervisor.applyDesired(doc('r2', []));
    await s.waitFor(() => s.frames.some((f) => f.event === 'end'), 'end frame');
    await s.waitFor(() => s.isDone(), 'stream closed');
  });

  it('sends event:end and closes when a config change replaces the session; a reconnect reaches the new session', async () => {
    await supervisor.applyDesired(doc('r1', [sess('s1')]));
    const s = sseReader(await connect('s1'));

    await supervisor.applyDesired(doc('r2', [sess('s1', { source: { channelUuid: 'uuid-2' } })]));
    await s.waitFor(() => s.frames.some((f) => f.event === 'end'), 'end frame');
    await s.waitFor(() => s.isDone(), 'stream closed');

    const s2 = sseReader(await connect('s1'));
    rig('s1').spawn.ffmpeg().writeStderr('replacement session line');
    await s2.waitFor(() => s2.frames.some((f) => f.data.includes('replacement session line')), 'line from replacement');
    s2.cancel();
  });

  it('serves an invalid session (no live Session object) as an empty replay that ends immediately', async () => {
    // invalid sessions only arise from disk (PUT validates all-or-nothing)
    const store = new DesiredStore(join(dir, 'desired.json'), silentLogger);
    await store.save(doc('r1', [sess('unbuildable-x')]));
    await supervisor.startFromDisk();
    expect(supervisor.statuses().find((s) => s.name === 'unbuildable-x')?.state).toBe('invalid');

    const res = await connect('unbuildable-x');
    expect(res.status).toBe(200);
    const s = sseReader(res);
    await s.waitFor(() => s.isDone(), 'immediate end');
    expect(s.frames.filter((f) => f.event === 'log')).toHaveLength(0);
    expect(s.frames.some((f) => f.event === 'end')).toBe(true);
  });

  it('endAllLogStreams() before server.close() lets shutdown complete with streams open', async () => {
    await supervisor.applyDesired(doc('r1', [sess('s1')]));
    const s = sseReader(await connect('s1'));
    await s.waitFor(() => true, 'connected');

    supervisor.endAllLogStreams();
    const closed = await Promise.race([
      server.close().then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 5_000)),
    ]);
    expect(closed).toBe(true); // would hang without endAllLogStreams (regression guard)
    await s.waitFor(() => s.isDone(), 'stream closed');
  });
});

describe('POST /v1/sessions/:name/restarts/reset', () => {
  let dir: string;
  let supervisor: Supervisor;
  let catalog: SourcesCatalog;
  let server: FastifyInstance;
  let base: string;
  let rigs: Map<string, { spawn: FakeSpawn }>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'restreamer-reset-'));
    rigs = new Map();
    supervisor = new Supervisor({
      buildPipeline: (session) => sampleBuilt(session.name),
      store: new DesiredStore(join(dir, 'desired.json'), silentLogger),
      config: testConfig(),
      logger: silentLogger,
      sessionFactory: (init) => {
        const spawn = fakeSpawn();
        const source = fakeSource(200);
        const fs = memFs();
        rigs.set(init.desired.name, { spawn });
        return new Session({
          desired: init.desired,
          pipeline: init.pipeline,
          configHash: init.configHash,
          settings: sampleSettings({ stallTimeoutSec: 9_999, stopGraceSec: 0 }),
          deps: {
            spawnImpl: spawn.impl,
            fetchImpl: source.fetchImpl,
            fs: fs.ops,
            rng: () => 0.5,
            logger: silentLogger,
            readRssMb: async () => null,
          },
        });
      },
      fs: { rm: async () => undefined },
    });
    catalog = new SourcesCatalog(null, { logger: silentLogger });
    await catalog.start();
    server = createServer({ supervisor, config: testConfig(), catalog, logger: silentLogger });
    await server.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    supervisor.endAllLogStreams();
    await server.close();
    await supervisor.stopAll();
    catalog.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('zeroes restarts via the API without disturbing the running generation; 404s for unknown names', async () => {
    await supervisor.applyDesired({ apiVersion: 1, revision: 'r1', sessions: [sampleDesired({ name: 's1' })] });
    await supervisor.restartSession('s1');
    const before = supervisor.statuses()[0]!;
    expect(before.restarts).toBe(1);

    const res = await fetch(`${base}/v1/sessions/s1/restarts/reset`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const after = supervisor.statuses()[0]!;
    expect(after.restarts).toBe(0);
    expect(after.state).toBe('running');
    expect(after.ffmpegPid).toBe(before.ffmpegPid); // generation untouched

    expect((await fetch(`${base}/v1/sessions/nope/restarts/reset`, { method: 'POST' })).status).toBe(404);
  });
});
