/*
 * Supervisor's *default* sessionFactory (the one it builds internally when no
 * SessionFactory is injected) — verifies the SessionSettings.segmentSeconds
 * wiring from `pipeline.segmentSeconds`. Every other Supervisor test in
 * this suite injects a FakeSession (see reconciler.test.ts), which bypasses
 * this settings-construction code entirely — this file is the only place it
 * runs. The real `Session` class is spied on (not faked) so the constructor
 * argument can be inspected without ever spawning a real child process
 * (the session used here is `enabled: false`, which `Session.start()`
 * short-circuits before touching spawn/fetch).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonConfig } from '../src/config.js';
import type { DesiredSession, DesiredState } from '../src/contract/v1.js';
import { DesiredStore } from '../src/state/desiredStore.js';
import type { SessionSettings } from '../src/supervise/types.js';
import { silentLogger } from './support/fakes.js';

const captured = vi.hoisted(() => ({ settings: undefined as SessionSettings | undefined }));

vi.mock('../src/supervise/session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/supervise/session.js')>();
  class SpySession extends actual.Session {
    constructor(init: ConstructorParameters<typeof actual.Session>[0]) {
      super(init);
      captured.settings = init.settings;
    }
  }
  return { ...actual, Session: SpySession };
});

// import AFTER the mock so Supervisor's default factory picks up SpySession
const { Supervisor } = await import('../src/supervise/supervisor.js');

function testConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    listen: { host: '127.0.0.1', port: 5580 },
    serveDir: '/media',
    stateFile: '/var/lib/restreamer/desired.json',
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
    cleanupOnRemove: true,
    cleanupDelaySec: 0,
    ...overrides,
  };
}

function doc(revision: string, sessions: DesiredSession[]): DesiredState {
  return { apiVersion: 1, revision, sessions };
}

describe('Supervisor default sessionFactory — SessionSettings.segmentSeconds wiring', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'restreamer-sup-factory-'));
    captured.settings = undefined;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeSupervisor(config: Partial<DaemonConfig> = {}) {
    return new Supervisor({
      buildPipeline: (session) => ({
        sourceUrl: 'http://tvh.example:9981/stream/channel/x',
        tsreadexArgv: [],
        ffmpegArgv: [],
        outDir: `/media/${session.name}`,
        needsProgramNumber: false,
      }),
      store: new DesiredStore(join(dir, 'desired.json'), silentLogger),
      config: testConfig(config),
      logger: silentLogger,
      fs: { rm: async () => undefined },
      // no sessionFactory override — exercises the default factory
    });
  }

  it('raw-argv: reads segmentSeconds from RawArgvParams', async () => {
    const sup = makeSupervisor();
    const session: DesiredSession = {
      name: 'raw-1',
      enabled: false, // Session.start() short-circuits before any spawn/fetch
      source: { channelUuid: 'uuid-raw' },
      tsreadex: { programNumber: 1 },
      pipeline: {
        template: 'raw-argv',
        templateVersion: 1,
        ffmpegArgv: ['-i', '-'],
        segmentSeconds: 2,
      },
    };
    await sup.applyDesired(doc('rev-1', [session]));
    expect(captured.settings?.segmentSeconds).toBe(2);
  });

  it('raw-argv: falls back to 5 when segmentSeconds is absent', async () => {
    const sup = makeSupervisor();
    const session: DesiredSession = {
      name: 'raw-2',
      enabled: false,
      source: { channelUuid: 'uuid-raw' },
      tsreadex: { programNumber: 1 },
      pipeline: { template: 'raw-argv', templateVersion: 1, ffmpegArgv: ['-i', '-'] },
    };
    await sup.applyDesired(doc('rev-1', [session]));
    expect(captured.settings?.segmentSeconds).toBe(5);
  });
});
