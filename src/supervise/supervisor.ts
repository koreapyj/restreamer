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
 * Desired ↔ running reconciler.
 *
 * Sessions are keyed by name with `configHash = stableHash(desiredSession)`
 * as the change detector: new → start; removed → graceful stop (+ rm outDir
 * when cleanupOnRemove); hash changed → stop, start fresh (counters reset by
 * construction); unchanged → NOT touched (a no-op PUT never disturbs a
 * running ffmpeg). `enabled:false` sessions exist as `disabled` — process
 * stopped, config + output dir kept.
 *
 * applyDesired: validate EVERYTHING first (schema + dry-run pipeline build;
 * all-or-nothing), persist BEFORE reconciling (a crash between the two is
 * recovered by startFromDisk), then reconcile. Reconciles are serialized and
 * coalesced — they always act on the latest desired doc.
 */

import fsp from 'node:fs/promises';
import { Value } from '@sinclair/typebox/value';
import { type DesiredSession, DesiredState, type SessionStatus } from '../contract/v1.js';
import type { DaemonConfig } from '../config.js';
import type { DesiredStore } from '../state/desiredStore.js';
import { stableHash } from '../util/hash.js';
import type { LogEntry } from '../util/logRing.js';
import { Session } from './session.js';
import type { BuildPipeline, BuiltPipeline, FsOps, Logger, SessionFactory, SessionLike } from './types.js';

interface SessionEntry {
  desired: DesiredSession;
  configHash: string;
  /** null when the persisted session no longer builds (state 'invalid') */
  session: SessionLike | null;
  outDir: string | null;
  invalidError?: string;
}

export interface SupervisorDeps {
  buildPipeline: BuildPipeline;
  store: DesiredStore;
  config: DaemonConfig;
  logger?: Logger;
  /** injectable for tests; default constructs a real Session from config */
  sessionFactory?: SessionFactory;
  /** used only for `rm -rf outDir` on removal */
  fs?: Pick<FsOps, 'rm'>;
  daemonVersion?: string;
}

export class Supervisor {
  private readonly sessions = new Map<string, SessionEntry>();
  private desired: DesiredState | null = null;

  private readonly buildPipeline: BuildPipeline;
  private readonly store: DesiredStore;
  private readonly config: DaemonConfig;
  private readonly logger: Logger;
  private readonly sessionFactory: SessionFactory;
  private readonly fs: Pick<FsOps, 'rm'>;

  private reconcileChain: Promise<void> = Promise.resolve();
  private reconcileQueued = false;
  private queuedResult: Promise<void> = Promise.resolve();

  constructor(deps: SupervisorDeps) {
    this.buildPipeline = deps.buildPipeline;
    this.store = deps.store;
    this.config = deps.config;
    this.logger = deps.logger ?? console;
    this.fs = deps.fs ?? fsp;
    this.sessionFactory =
      deps.sessionFactory ??
      ((init) =>
        new Session({
          desired: init.desired,
          pipeline: init.pipeline,
          configHash: init.configHash,
          settings: {
            daemonVersion: deps.daemonVersion ?? '0',
            tsreadexPath: this.config.tsreadexPath,
            ffmpegPath: this.config.ffmpegPath,
            stallTimeoutSec: this.config.stallTimeoutSec,
            playlistStallSec: this.config.playlistStallSec,
            segmentSeconds: init.desired.pipeline.hls?.segmentSeconds ?? 5,
            memoryLimitMb: this.config.memoryLimitMb,
            stopGraceSec: this.config.stopGraceSec,
            logCapacity: this.config.logLines,
            watchedPlaylistPath: '1080p/stream.m3u8',
          },
          deps: { logger: this.logger },
        }));
  }

  getDesired(): DesiredState | null {
    return this.desired;
  }

  get desiredRevision(): string | null {
    return this.desired?.revision ?? null;
  }

  /**
   * Full-replacement PUT: validate ALL sessions (schema + dry-run build) —
   * any failure throws with per-session details and nothing is applied.
   * On success the doc is persisted BEFORE reconciling.
   */
  async applyDesired(doc: DesiredState): Promise<void> {
    if (!Value.Check(DesiredState, doc)) {
      const details = [...Value.Errors(DesiredState, doc)]
        .slice(0, 20)
        .map((e) => `${e.path || '/'}: ${e.message}`)
        .join('; ');
      throw new Error(`desired state rejected (schema): ${details}`);
    }
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const session of doc.sessions) {
      if (seen.has(session.name)) errors.push(`${session.name}: duplicate session name`);
      seen.add(session.name);
      try {
        this.buildPipeline(session);
      } catch (err) {
        errors.push(`${session.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(`desired state rejected: ${errors.join('; ')}`);
    }
    await this.store.save(doc);
    this.desired = doc;
    await this.reconcile();
  }

  /** Load the persisted doc and reconcile; missing/corrupt state ⇒ zero sessions. */
  async startFromDisk(): Promise<void> {
    const doc = await this.store.load();
    if (doc === null) {
      this.desired = null;
      await this.reconcile();
      return;
    }
    if (!Value.Check(DesiredState, doc)) {
      this.logger.error(
        'persisted desired state no longer passes schema validation — starting with zero sessions, waiting for a controller push',
      );
      this.desired = null;
      await this.reconcile();
      return;
    }
    this.desired = doc;
    await this.reconcile();
  }

  /** One reconcile at a time; concurrent requests coalesce onto the latest desired doc. */
  reconcile(): Promise<void> {
    if (this.reconcileQueued) return this.queuedResult;
    this.reconcileQueued = true;
    const result = this.reconcileChain.then(() => {
      this.reconcileQueued = false;
      return this.doReconcile();
    });
    this.queuedResult = result;
    // keep the chain alive even if a reconcile rejects
    this.reconcileChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Parallel graceful stop of everything (SIGTERM path). Sessions never throw on stop. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((entry) => entry.session?.stop()));
  }

  async restartSession(name: string): Promise<void> {
    const entry = this.sessions.get(name);
    if (!entry?.session) throw new Error(`unknown session: ${name}`);
    await entry.session.restart();
  }

  /**
   * Ring-buffer tail for one session. `null` = unknown session (the API maps
   * it to 404); an `invalid` session (no live Session object) yields [].
   */
  sessionLog(name: string, lines: number): LogEntry[] | null {
    const entry = this.sessions.get(name);
    if (!entry) return null;
    return entry.session?.logTail?.(lines) ?? [];
  }

  statuses(): SessionStatus[] {
    const out: SessionStatus[] = [];
    for (const entry of this.sessions.values()) {
      if (entry.session) {
        out.push(entry.session.status());
      } else {
        out.push({
          name: entry.desired.name,
          state: 'invalid',
          enabled: entry.desired.enabled !== false,
          configHash: entry.configHash,
          restarts: 0,
          consecutiveFailures: 0,
          lastError: entry.invalidError,
        });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------

  private async doReconcile(): Promise<void> {
    const desiredByName = new Map<string, DesiredSession>();
    for (const session of this.desired?.sessions ?? []) desiredByName.set(session.name, session);

    // removed → graceful stop, then rm -rf outDir when configured
    for (const [name, entry] of [...this.sessions]) {
      if (desiredByName.has(name)) continue;
      this.logger.info(`[supervisor] session ${name} removed — stopping`);
      await entry.session?.stop();
      this.sessions.delete(name);
      if (this.config.cleanupOnRemove && entry.outDir) {
        await this.fs.rm(entry.outDir, { recursive: true, force: true }).catch((err: unknown) => {
          this.logger.warn(
            `[supervisor] cleanup of ${entry.outDir} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    }

    for (const [name, desired] of desiredByName) {
      const configHash = stableHash(desired);
      const existing = this.sessions.get(name);
      if (existing && existing.configHash === configHash) continue; // unchanged → NOT touched
      if (existing) {
        this.logger.info(`[supervisor] session ${name} changed — replacing`);
        await existing.session?.stop();
        this.sessions.delete(name);
      }
      await this.createAndStart(name, desired, configHash);
    }
  }

  private async createAndStart(name: string, desired: DesiredSession, configHash: string): Promise<void> {
    let pipeline: BuiltPipeline;
    try {
      pipeline = this.buildPipeline(desired);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[supervisor] session ${name} no longer builds: ${msg}`);
      this.sessions.set(name, { desired, configHash, session: null, outDir: null, invalidError: msg });
      return;
    }
    let session: SessionLike;
    try {
      session = this.sessionFactory({ desired, pipeline, configHash });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[supervisor] session ${name} could not be created: ${msg}`);
      this.sessions.set(name, { desired, configHash, session: null, outDir: pipeline.outDir, invalidError: msg });
      return;
    }
    this.sessions.set(name, { desired, configHash, session, outDir: pipeline.outDir });
    await session.start();
  }
}
