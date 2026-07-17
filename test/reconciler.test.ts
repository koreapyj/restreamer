/*
 * Supervisor/reconciler: add/remove/change/disable/no-op, cleanupOnRemove,
 * all-or-nothing validation, persist-before-reconcile crash recovery, and
 * startFromDisk with missing/corrupt state.
 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonConfig } from '../src/config.js';
import type { DesiredSession, DesiredState, SessionStatus } from '../src/contract/v1.js';
import { DesiredStore } from '../src/state/desiredStore.js';
import { Supervisor } from '../src/supervise/supervisor.js';
import type { BuildPipeline, SessionFactory, SessionFactoryInit, Timers } from '../src/supervise/types.js';
import { stableHash } from '../src/util/hash.js';
import { manualTimers, sampleBuilt, sampleDesired, silentLogger } from './support/fakes.js';

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
    // immediate by default so the existing sync-rm assertions hold; the
    // delayed-cleanup suite overrides this and injects a manual clock
    cleanupDelaySec: 0,
    ...overrides,
  };
}

class FakeSession {
  startCalls = 0;
  stopCalls = 0;
  restartCalls = 0;
  endLogStreamsCalls = 0;
  resetRestartsCalls = 0;
  /** stopCalls value at the moment of the first endLogStreams() — streams must end before the drain */
  stopCallsAtFirstEnd: number | null = null;
  private state: 'starting' | 'running' | 'disabled' = 'starting';

  constructor(readonly init: SessionFactoryInit) {}

  async start(): Promise<void> {
    this.startCalls++;
    this.state = this.init.desired.enabled === false ? 'disabled' : 'running';
  }

  async stop(): Promise<void> {
    this.stopCalls++;
    this.state = 'disabled';
  }

  async restart(): Promise<void> {
    this.restartCalls++;
  }

  endLogStreams(): void {
    if (this.endLogStreamsCalls === 0) this.stopCallsAtFirstEnd = this.stopCalls;
    this.endLogStreamsCalls++;
  }

  resetRestarts(): void {
    this.resetRestartsCalls++;
  }

  status(): SessionStatus {
    return {
      name: this.init.desired.name,
      state: this.state,
      enabled: this.init.desired.enabled !== false,
      configHash: this.init.configHash,
      restarts: 0,
      consecutiveFailures: 0,
    };
  }
}

const buildPipeline: BuildPipeline = (session) => {
  if (session.name.startsWith('unbuildable')) throw new Error(`template rejected params for ${session.name}`);
  return sampleBuilt(session.name);
};

function sess(name: string, overrides: Partial<DesiredSession> = {}): DesiredSession {
  return sampleDesired({ name, ...overrides });
}

function doc(revision: string, sessions: DesiredSession[]): DesiredState {
  return { apiVersion: 1, revision, sessions };
}

describe('Supervisor', () => {
  let dir: string;
  let created: FakeSession[];
  let rmCalls: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'restreamer-sup-'));
    created = [];
    rmCalls = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeSupervisor(
    opts: {
      config?: Partial<DaemonConfig>;
      factory?: SessionFactory;
      timers?: Timers;
      /** serveDir listing seen by the boot-time orphan sweep (default: empty) */
      dirEntries?: { name: string; isDirectory(): boolean }[];
      /** paths whose rm fails with this message (retry-path tests) */
      rmFails?: Map<string, string>;
    } = {},
  ) {
    const factory: SessionFactory =
      opts.factory ??
      ((init) => {
        const s = new FakeSession(init);
        created.push(s);
        return s;
      });
    return new Supervisor({
      buildPipeline,
      store: new DesiredStore(join(dir, 'desired.json'), silentLogger),
      config: testConfig(opts.config),
      logger: silentLogger,
      sessionFactory: factory,
      fs: {
        rm: async (p: string) => {
          const failMsg = opts.rmFails?.get(p);
          if (failMsg !== undefined) throw new Error(failMsg);
          rmCalls.push(p);
        },
        readdir: async () => opts.dirEntries ?? [],
      },
      ...(opts.timers ? { timers: opts.timers } : {}),
    });
  }

  const dirEntry = (name: string, isDir = true) => ({ name, isDirectory: () => isDir });

  function byName(sup: Supervisor, name: string): SessionStatus | undefined {
    return sup.statuses().find((s) => s.name === name);
  }

  it('starts new sessions, surfaces configHash, and persists the doc', async () => {
    const sup = makeSupervisor();
    const d = doc('rev-1', [sess('alpha'), sess('beta')]);
    await sup.applyDesired(d);

    expect(created).toHaveLength(2);
    expect(created.every((s) => s.startCalls === 1)).toBe(true);
    expect(byName(sup, 'alpha')?.state).toBe('running');
    expect(byName(sup, 'alpha')?.configHash).toBe(stableHash(sess('alpha')));
    expect(sup.desiredRevision).toBe('rev-1');
    expect(sup.getDesired()).toEqual(d);

    // persisted
    const store = new DesiredStore(join(dir, 'desired.json'), silentLogger);
    expect(await store.load()).toEqual(d);
  });

  it('applyDesired accepts a doc with two raw-argv sessions and reconciles both', async () => {
    const sup = makeSupervisor();
    const rawSession = sess('raw-1', {
      pipeline: { template: 'raw-argv', templateVersion: 1, ffmpegArgv: ['-i', '-', '{OUT_DIR}/%v/stream.m3u8'] },
    });
    const d = doc('rev-1', [sess('alpha'), rawSession]);
    await sup.applyDesired(d);

    expect(created).toHaveLength(2);
    expect(created.every((s) => s.startCalls === 1)).toBe(true);
    expect(byName(sup, 'alpha')?.state).toBe('running');
    expect(byName(sup, 'raw-1')?.state).toBe('running');
    expect(sup.getDesired()).toEqual(d);
  });

  it('no-op PUT (same sessions, new revision) never touches a running session', async () => {
    const sup = makeSupervisor();
    await sup.applyDesired(doc('rev-1', [sess('alpha')]));
    const instance = created[0] as FakeSession;

    await sup.applyDesired(doc('rev-2', [sess('alpha')]));

    expect(created).toHaveLength(1); // same instance, not recreated
    expect(instance.startCalls).toBe(1);
    expect(instance.stopCalls).toBe(0);
    expect(sup.desiredRevision).toBe('rev-2'); // revision still updated
  });

  it('config change stops the old session and starts a fresh one', async () => {
    const sup = makeSupervisor();
    await sup.applyDesired(doc('rev-1', [sess('alpha')]));
    const old = created[0] as FakeSession;

    await sup.applyDesired(doc('rev-2', [sess('alpha', { tsreadex: { programNumber: 2064 } })]));

    expect(old.stopCalls).toBe(1);
    expect(created).toHaveLength(2);
    expect((created[1] as FakeSession).startCalls).toBe(1);
    expect(byName(sup, 'alpha')?.configHash).toBe(stableHash(sess('alpha', { tsreadex: { programNumber: 2064 } })));
  });

  it('removed sessions are stopped and their outDir removed when cleanupOnRemove', async () => {
    const sup = makeSupervisor();
    await sup.applyDesired(doc('rev-1', [sess('alpha'), sess('beta')]));

    await sup.applyDesired(doc('rev-2', [sess('alpha')]));

    const beta = created[1] as FakeSession;
    expect(beta.stopCalls).toBe(1);
    expect(rmCalls).toEqual(['/media/beta']);
    expect(byName(sup, 'beta')).toBeUndefined();
    expect(byName(sup, 'alpha')?.state).toBe('running');
  });

  it('keeps the output dir when cleanupOnRemove is false', async () => {
    const sup = makeSupervisor({ config: { cleanupOnRemove: false } });
    await sup.applyDesired(doc('rev-1', [sess('alpha')]));
    await sup.applyDesired(doc('rev-2', []));

    expect((created[0] as FakeSession).stopCalls).toBe(1);
    expect(rmCalls).toEqual([]);
  });

  it('enabled:false stops the process but keeps the session as disabled (dir kept)', async () => {
    const sup = makeSupervisor();
    await sup.applyDesired(doc('rev-1', [sess('alpha')]));
    await sup.applyDesired(doc('rev-2', [sess('alpha', { enabled: false })]));

    expect((created[0] as FakeSession).stopCalls).toBe(1);
    expect(byName(sup, 'alpha')?.state).toBe('disabled');
    expect(byName(sup, 'alpha')?.enabled).toBe(false);
    expect(rmCalls).toEqual([]); // disable ≠ remove
  });

  it('validation is all-or-nothing: one bad session rejects the whole doc, nothing applied', async () => {
    const sup = makeSupervisor();
    await sup.applyDesired(doc('rev-1', [sess('alpha')]));
    const before = created.length;

    await expect(
      sup.applyDesired(doc('rev-2', [sess('alpha', { tsreadex: { programNumber: 9999 } }), sess('unbuildable-x')])),
    ).rejects.toThrow(/unbuildable-x: template rejected params/);

    // nothing applied: no new sessions, old one untouched, old doc still persisted
    expect(created).toHaveLength(before);
    expect((created[0] as FakeSession).stopCalls).toBe(0);
    expect(sup.desiredRevision).toBe('rev-1');
    const store = new DesiredStore(join(dir, 'desired.json'), silentLogger);
    expect((await store.load())?.revision).toBe('rev-1');
  });

  it('rejects schema violations (bad name, wrong apiVersion, duplicates) with details', async () => {
    const sup = makeSupervisor();
    await expect(sup.applyDesired(doc('rev-1', [sess('Bad_Name' as never)]))).rejects.toThrow(/schema/);
    await expect(
      sup.applyDesired({ ...doc('rev-1', [sess('alpha')]), apiVersion: 2 as never }),
    ).rejects.toThrow(/schema/);
    await expect(sup.applyDesired(doc('rev-1', [sess('alpha'), sess('alpha')]))).rejects.toThrow(
      /duplicate session name/,
    );
    expect(created).toHaveLength(0);
  });

  it('persists BEFORE reconciling: a crashing session factory loses nothing — startFromDisk resumes', async () => {
    const crashing = makeSupervisor({
      factory: () => {
        throw new Error('simulated crash during reconcile');
      },
    });
    const d = doc('rev-1', [sess('alpha')]);
    await crashing.applyDesired(d); // reconcile degrades, must not lose the doc
    expect(byName(crashing, 'alpha')?.state).toBe('invalid');
    expect(byName(crashing, 'alpha')?.lastError).toContain('simulated crash');

    // "daemon restart" with a healthy factory
    const sup = makeSupervisor();
    await sup.startFromDisk();
    expect(sup.desiredRevision).toBe('rev-1');
    expect(byName(sup, 'alpha')?.state).toBe('running');
    expect((created[0] as FakeSession).startCalls).toBe(1);
  });

  it('a persisted session that no longer builds surfaces as invalid instead of crashing startup', async () => {
    const store = new DesiredStore(join(dir, 'desired.json'), silentLogger);
    await store.save(doc('rev-1', [sess('alpha'), sess('unbuildable-y')]));

    const sup = makeSupervisor();
    await sup.startFromDisk();
    expect(byName(sup, 'alpha')?.state).toBe('running');
    expect(byName(sup, 'unbuildable-y')?.state).toBe('invalid');
    expect(byName(sup, 'unbuildable-y')?.lastError).toContain('template rejected params');
  });

  it('startFromDisk with a corrupt state file moves it aside and starts zero sessions', async () => {
    await writeFile(join(dir, 'desired.json'), '{not json');
    const sup = makeSupervisor();
    await sup.startFromDisk();
    expect(sup.statuses()).toEqual([]);
    expect((await readdir(dir)).some((e) => e.startsWith('desired.json.corrupt-'))).toBe(true);
  });

  it('stopAll gracefully stops every session in parallel', async () => {
    const sup = makeSupervisor();
    await sup.applyDesired(doc('rev-1', [sess('alpha'), sess('beta')]));
    await sup.stopAll();
    expect(created.every((s) => s.stopCalls === 1)).toBe(true);
  });

  it('restartSession delegates to the session; unknown names throw', async () => {
    const sup = makeSupervisor();
    await sup.applyDesired(doc('rev-1', [sess('alpha')]));
    await sup.restartSession('alpha');
    expect((created[0] as FakeSession).restartCalls).toBe(1);
    await expect(sup.restartSession('ghost')).rejects.toThrow(/unknown session/);
  });

  it('ends log streams before stopping a removed session', async () => {
    const sup = makeSupervisor();
    await sup.applyDesired(doc('rev-1', [sess('alpha'), sess('beta')]));
    await sup.applyDesired(doc('rev-2', [sess('alpha')])); // remove beta
    const beta = created[1] as FakeSession;
    expect(beta.endLogStreamsCalls).toBe(1);
    expect(beta.stopCallsAtFirstEnd).toBe(0); // streams ended BEFORE the graceful drain
    expect((created[0] as FakeSession).endLogStreamsCalls).toBe(0); // survivor untouched
  });

  it('ends log streams on the discarded session when a config change replaces it', async () => {
    const sup = makeSupervisor();
    await sup.applyDesired(doc('rev-1', [sess('alpha')]));
    await sup.applyDesired(doc('rev-2', [sess('alpha', { enabled: false })])); // hash change → replace
    const old = created[0] as FakeSession;
    expect(old.endLogStreamsCalls).toBe(1);
    expect(old.stopCallsAtFirstEnd).toBe(0);
    expect((created[1] as FakeSession).endLogStreamsCalls).toBe(0);
  });

  it('endAllLogStreams ends streams on every live session', async () => {
    const sup = makeSupervisor();
    await sup.applyDesired(doc('rev-1', [sess('alpha'), sess('beta')]));
    sup.endAllLogStreams();
    expect(created.every((s) => s.endLogStreamsCalls === 1)).toBe(true);
  });

  it('resetSessionRestarts delegates to the session; unknown or invalid names return false', async () => {
    const sup = makeSupervisor();
    await sup.applyDesired(doc('rev-1', [sess('alpha')]));
    expect(sup.resetSessionRestarts('alpha')).toBe(true);
    expect((created[0] as FakeSession).resetRestartsCalls).toBe(1);
    expect(sup.resetSessionRestarts('ghost')).toBe(false);
  });

  it('subscribeSessionLog: null for unknown names, empty non-live subscription for invalid sessions', async () => {
    const sup = makeSupervisor();
    await sup.applyDesired(doc('rev-1', [sess('alpha')]));
    // startFromDisk with a doc containing a session that no longer builds → invalid entry
    const sup2 = makeSupervisor();
    const store = new DesiredStore(join(dir, 'desired.json'), silentLogger);
    await store.save(doc('rev-2', [sess('unbuildable-x')]));
    await sup2.startFromDisk();
    expect(byName(sup2, 'unbuildable-x')?.state).toBe('invalid');

    const noop = { onLine: () => undefined, onEnd: () => undefined };
    expect(sup.subscribeSessionLog('ghost', 10, noop)).toBeNull();
    const invalidSub = sup2.subscribeSessionLog('unbuildable-x', 10, noop);
    expect(invalidSub).not.toBeNull();
    expect(invalidSub!.live).toBe(false);
    expect(invalidSub!.tail).toEqual([]);
    expect(sup2.resetSessionRestarts('unbuildable-x')).toBe(false); // action on invalid → 404 path
  });

  describe('delayed cleanup', () => {
    it('defers rm by the derived HLS window (segmentSeconds × listSize)', async () => {
      const clock = manualTimers();
      const sup = makeSupervisor({ config: { cleanupDelaySec: null }, timers: clock.timers });
      await sup.applyDesired(doc('rev-1', [sess('alpha'), sess('beta')]));
      await sup.applyDesired(doc('rev-2', [sess('alpha')])); // remove beta

      expect((created[1] as FakeSession).stopCalls).toBe(1); // stopped immediately
      expect(rmCalls).toEqual([]); // but NOT yet deleted
      expect(byName(sup, 'beta')).toBeUndefined();

      await clock.tick(600_000 - 1); // 5 × 120 = 600s; one ms short
      expect(rmCalls).toEqual([]);
      await clock.tick(1);
      expect(rmCalls).toEqual(['/media/beta']);
      expect(clock.pending()).toBe(0);
    });

    it('derives the delay from RawArgvParams.segmentSeconds/listSize for a raw-argv session', async () => {
      const clock = manualTimers();
      const sup = makeSupervisor({ config: { cleanupDelaySec: null }, timers: clock.timers });
      const rawBeta = sess('beta', {
        pipeline: {
          template: 'raw-argv',
          templateVersion: 1,
          ffmpegArgv: ['-i', '-'],
          segmentSeconds: 2,
          listSize: 60,
        },
      });
      await sup.applyDesired(doc('rev-1', [sess('alpha'), rawBeta]));
      await sup.applyDesired(doc('rev-2', [sess('alpha')])); // remove beta

      await clock.tick(120_000 - 1); // 2 × 60 = 120s; one ms short
      expect(rmCalls).toEqual([]);
      await clock.tick(1);
      expect(rmCalls).toEqual(['/media/beta']);
    });

    it('a non-null cleanupDelaySec overrides the derived delay', async () => {
      const clock = manualTimers();
      const sup = makeSupervisor({ config: { cleanupDelaySec: 30 }, timers: clock.timers });
      await sup.applyDesired(doc('rev-1', [sess('alpha'), sess('beta')]));
      await sup.applyDesired(doc('rev-2', [sess('alpha')]));

      await clock.tick(29_999);
      expect(rmCalls).toEqual([]);
      await clock.tick(1);
      expect(rmCalls).toEqual(['/media/beta']);
    });

    it('cleanupDelaySec:0 deletes immediately (no timer)', async () => {
      const clock = manualTimers();
      const sup = makeSupervisor({ config: { cleanupDelaySec: 0 }, timers: clock.timers });
      await sup.applyDesired(doc('rev-1', [sess('alpha'), sess('beta')]));
      await sup.applyDesired(doc('rev-2', [sess('alpha')]));

      expect(rmCalls).toEqual(['/media/beta']); // synchronous, before any tick
      expect(clock.pending()).toBe(0);
    });

    it('re-adding a session before its deletion fires cancels the deletion (name reuse)', async () => {
      const clock = manualTimers();
      const sup = makeSupervisor({ config: { cleanupDelaySec: null }, timers: clock.timers });
      await sup.applyDesired(doc('rev-1', [sess('alpha'), sess('beta')]));
      await sup.applyDesired(doc('rev-2', [sess('alpha')])); // remove beta → schedule
      await sup.applyDesired(doc('rev-3', [sess('alpha'), sess('beta')])); // re-add before fire

      expect(clock.pending()).toBe(0); // timer disarmed
      await clock.tick(600_000);
      expect(rmCalls).toEqual([]); // dir was never deleted — reused by the new session
      expect(byName(sup, 'beta')?.state).toBe('running');
    });

    it('rapid remove→add→remove reschedules and deletes exactly once', async () => {
      const clock = manualTimers();
      const sup = makeSupervisor({ config: { cleanupDelaySec: null }, timers: clock.timers });
      await sup.applyDesired(doc('rev-1', [sess('alpha'), sess('beta')]));
      await sup.applyDesired(doc('rev-2', [sess('alpha')])); // remove (token 1)
      await sup.applyDesired(doc('rev-3', [sess('alpha'), sess('beta')])); // re-add (cancel)
      await sup.applyDesired(doc('rev-4', [sess('alpha')])); // remove again (token 2)

      await clock.tick(600_000);
      expect(rmCalls).toEqual(['/media/beta']); // exactly one deletion
    });

    it('in-place replace (hash change, no removal in between) does not rm the dir', async () => {
      const clock = manualTimers();
      const sup = makeSupervisor({ config: { cleanupDelaySec: null }, timers: clock.timers });
      await sup.applyDesired(doc('rev-1', [sess('alpha')]));
      await sup.applyDesired(doc('rev-2', [sess('alpha', { tsreadex: { programNumber: 2064 } })]));

      expect(rmCalls).toEqual([]);
      await clock.tick(600_000);
      expect(rmCalls).toEqual([]);
    });

    it('stopAll disarms pending deletion timers but leaves the dirs on disk (drain outlives the daemon)', async () => {
      const clock = manualTimers();
      const sup = makeSupervisor({ config: { cleanupDelaySec: null }, timers: clock.timers });
      await sup.applyDesired(doc('rev-1', [sess('alpha'), sess('beta')]));
      await sup.applyDesired(doc('rev-2', [sess('alpha')])); // remove beta → pending

      await sup.stopAll();
      expect(rmCalls).toEqual([]); // dir kept — nginx is still serving the drain
      expect(clock.pending()).toBe(0); // but the timer is disarmed

      await clock.tick(600_000); // nothing fires after shutdown
      expect(rmCalls).toEqual([]);
    });
  });

  describe('pendingRemovals / lastAppliedAt / persistedStateCorrupt (status surface)', () => {
    it('reports a scheduled removal with its outDir and ISO deadline, then clears on fire', async () => {
      const clock = manualTimers();
      const sup = makeSupervisor({ config: { cleanupDelaySec: 30 }, timers: clock.timers });
      await sup.applyDesired(doc('rev-1', [sess('alpha'), sess('beta')]));
      await sup.applyDesired(doc('rev-2', [sess('alpha')])); // remove beta → schedule at now+30s

      expect(sup.pendingRemovals()).toEqual([
        { name: 'beta', outDir: '/media/beta', deadline: new Date(30_000).toISOString() },
      ]);

      await clock.tick(30_000);
      expect(rmCalls).toEqual(['/media/beta']);
      expect(sup.pendingRemovals()).toEqual([]);
    });

    it('a failed rm keeps the entry with error set and retries after 60s; success clears it', async () => {
      const clock = manualTimers();
      const rmFails = new Map([['/media/beta', 'EBUSY: resource busy']]);
      const sup = makeSupervisor({ config: { cleanupDelaySec: 30 }, timers: clock.timers, rmFails });
      await sup.applyDesired(doc('rev-1', [sess('alpha'), sess('beta')]));
      await sup.applyDesired(doc('rev-2', [sess('alpha')]));

      await clock.tick(30_000); // deletion fires — rm fails
      expect(rmCalls).toEqual([]);
      expect(sup.pendingRemovals()).toEqual([
        { name: 'beta', outDir: '/media/beta', deadline: new Date(90_000).toISOString(), error: 'EBUSY: resource busy' },
      ]);
      expect(clock.pending()).toBe(1); // retry armed

      await clock.tick(60_000); // first retry — still failing
      expect(sup.pendingRemovals()[0]?.error).toBe('EBUSY: resource busy');
      expect(sup.pendingRemovals()[0]?.deadline).toBe(new Date(150_000).toISOString());

      rmFails.delete('/media/beta'); // dir becomes removable
      await clock.tick(60_000); // second retry succeeds
      expect(rmCalls).toEqual(['/media/beta']);
      expect(sup.pendingRemovals()).toEqual([]);
      expect(clock.pending()).toBe(0);
    });

    it('an immediate rm (cleanupDelaySec 0) that fails also lands in pendingRemovals and retries', async () => {
      const clock = manualTimers();
      const rmFails = new Map([['/media/beta', 'EPERM: operation not permitted']]);
      const sup = makeSupervisor({ config: { cleanupDelaySec: 0 }, timers: clock.timers, rmFails });
      await sup.applyDesired(doc('rev-1', [sess('alpha'), sess('beta')]));
      await sup.applyDesired(doc('rev-2', [sess('alpha')]));

      expect(sup.pendingRemovals()[0]?.error).toBe('EPERM: operation not permitted');

      rmFails.clear();
      await clock.tick(60_000);
      expect(rmCalls).toEqual(['/media/beta']);
      expect(sup.pendingRemovals()).toEqual([]);
    });

    it('re-adding a name whose rm is in retry cancels the retry (dir reused)', async () => {
      const clock = manualTimers();
      const rmFails = new Map([['/media/beta', 'EBUSY']]);
      const sup = makeSupervisor({ config: { cleanupDelaySec: 0 }, timers: clock.timers, rmFails });
      await sup.applyDesired(doc('rev-1', [sess('alpha'), sess('beta')]));
      await sup.applyDesired(doc('rev-2', [sess('alpha')])); // rm fails → retry pending
      expect(sup.pendingRemovals()).toHaveLength(1);

      await sup.applyDesired(doc('rev-3', [sess('alpha'), sess('beta')])); // re-add
      expect(sup.pendingRemovals()).toEqual([]);
      expect(clock.pending()).toBe(0);
      await clock.tick(120_000);
      expect(rmCalls).toEqual([]); // cancelled retry never fires
    });

    it('stopAll disarms a pending rm-retry timer too', async () => {
      const clock = manualTimers();
      const rmFails = new Map([['/media/beta', 'EBUSY']]);
      const sup = makeSupervisor({ config: { cleanupDelaySec: 0 }, timers: clock.timers, rmFails });
      await sup.applyDesired(doc('rev-1', [sess('beta')]));
      await sup.applyDesired(doc('rev-2', [])); // rm fails → retry armed

      await sup.stopAll();
      expect(clock.pending()).toBe(0);
    });

    it('sets lastAppliedAt on a successful PUT and on a boot-time disk load', async () => {
      const clock = manualTimers();
      const sup = makeSupervisor({ timers: clock.timers });
      expect(sup.lastAppliedAt).toBeUndefined();

      await clock.tick(5_000);
      await sup.applyDesired(doc('rev-1', [sess('alpha')]));
      expect(sup.lastAppliedAt).toBe(new Date(5_000).toISOString());

      const clock2 = manualTimers();
      const sup2 = makeSupervisor({ timers: clock2.timers });
      await clock2.tick(9_000);
      await sup2.startFromDisk();
      expect(sup2.lastAppliedAt).toBe(new Date(9_000).toISOString());
    });

    it('a rejected PUT does not move lastAppliedAt', async () => {
      const clock = manualTimers();
      const sup = makeSupervisor({ timers: clock.timers });
      await sup.applyDesired(doc('rev-1', [sess('alpha')]));
      const applied = sup.lastAppliedAt;

      await clock.tick(1_000);
      await expect(sup.applyDesired(doc('rev-2', [sess('unbuildable-x')]))).rejects.toThrow();
      expect(sup.lastAppliedAt).toBe(applied);
    });

    it('startFromDisk with no doc sets neither lastAppliedAt nor the corrupt flag', async () => {
      const sup = makeSupervisor();
      await sup.startFromDisk();
      expect(sup.lastAppliedAt).toBeUndefined();
      expect(sup.persistedStateCorrupt).toBe(false);
    });

    it('flags a persisted doc that fails schema validation; a successful PUT clears the flag', async () => {
      // valid JSON, invalid schema (apiVersion 99)
      await writeFile(join(dir, 'desired.json'), JSON.stringify({ apiVersion: 99, revision: 'x', sessions: [] }));
      const sup = makeSupervisor();
      await sup.startFromDisk();
      expect(sup.persistedStateCorrupt).toBe(true);
      expect(sup.lastAppliedAt).toBeUndefined();
      expect(sup.statuses()).toEqual([]);

      await sup.applyDesired(doc('rev-1', [sess('alpha')]));
      expect(sup.persistedStateCorrupt).toBe(false);
      expect(sup.lastAppliedAt).toBeDefined();
    });
  });

  describe('boot-time orphan sweep', () => {
    it('schedules deletion of serveDir dirs owned by no desired session, after the fixed orphan grace', async () => {
      const clock = manualTimers();
      const store = new DesiredStore(join(dir, 'desired.json'), silentLogger);
      await store.save(doc('rev-1', [sess('alpha')]));
      const sup = makeSupervisor({
        timers: clock.timers,
        dirEntries: [dirEntry('alpha'), dirEntry('stale-1'), dirEntry('stale-2')],
      });
      await sup.startFromDisk();

      expect(sup.pendingRemovals().map((p) => p.name).sort()).toEqual(['stale-1', 'stale-2']);
      expect(sup.pendingRemovals()[0]?.deadline).toBe(new Date(600_000).toISOString());

      await clock.tick(600_000 - 1);
      expect(rmCalls).toEqual([]);
      await clock.tick(1);
      expect(rmCalls.sort()).toEqual(['/media/stale-1', '/media/stale-2']);
      expect(sup.pendingRemovals()).toEqual([]);
    });

    it('ignores plain files in serveDir', async () => {
      const clock = manualTimers();
      const sup = makeSupervisor({
        timers: clock.timers,
        dirEntries: [dirEntry('notes.txt', false), dirEntry('stale')],
      });
      await sup.startFromDisk();
      expect(sup.pendingRemovals().map((p) => p.name)).toEqual(['stale']);
    });

    it('skips the sweep entirely when cleanupOnRemove is false', async () => {
      const clock = manualTimers();
      const sup = makeSupervisor({
        config: { cleanupOnRemove: false },
        timers: clock.timers,
        dirEntries: [dirEntry('stale')],
      });
      await sup.startFromDisk();
      expect(sup.pendingRemovals()).toEqual([]);
      expect(clock.pending()).toBe(0);
    });

    it('a readdir failure logs and skips the sweep', async () => {
      const clock = manualTimers();
      const sup = new Supervisor({
        buildPipeline,
        store: new DesiredStore(join(dir, 'desired.json'), silentLogger),
        config: testConfig(),
        logger: silentLogger,
        sessionFactory: (init) => new FakeSession(init),
        fs: {
          rm: async () => undefined,
          readdir: async () => {
            throw new Error('EACCES: permission denied');
          },
        },
        timers: clock.timers,
      });
      await sup.startFromDisk(); // must not throw
      expect(sup.pendingRemovals()).toEqual([]);
    });

    it('a desired session name found on disk survives the sweep even while sessions are running', async () => {
      const clock = manualTimers();
      const store = new DesiredStore(join(dir, 'desired.json'), silentLogger);
      await store.save(doc('rev-1', [sess('alpha'), sess('beta')]));
      const sup = makeSupervisor({
        timers: clock.timers,
        dirEntries: [dirEntry('alpha'), dirEntry('beta')],
      });
      await sup.startFromDisk();
      expect(sup.pendingRemovals()).toEqual([]);
      await clock.tick(600_000);
      expect(rmCalls).toEqual([]);
    });
  });
});
