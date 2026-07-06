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
import type { BuildPipeline, SessionFactory, SessionFactoryInit } from '../src/supervise/types.js';
import { stableHash } from '../src/util/hash.js';
import { sampleBuilt, sampleDesired, silentLogger } from './support/fakes.js';

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
    ...overrides,
  };
}

class FakeSession {
  startCalls = 0;
  stopCalls = 0;
  restartCalls = 0;
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

  function makeSupervisor(opts: { config?: Partial<DaemonConfig>; factory?: SessionFactory } = {}) {
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
          rmCalls.push(p);
        },
      },
    });
  }

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

  it('startFromDisk with no state file starts zero sessions', async () => {
    const sup = makeSupervisor();
    await sup.startFromDisk();
    expect(sup.statuses()).toEqual([]);
    expect(sup.getDesired()).toBeNull();
    expect(sup.desiredRevision).toBeNull();
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
});
