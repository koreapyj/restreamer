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
import { defaultTimers, Session } from './session.js';
import type {
  BuildPipeline,
  BuiltPipeline,
  FsOps,
  Logger,
  LogSubscriber,
  LogSubscription,
  SessionFactory,
  SessionLike,
  Timers,
} from './types.js';

/** ceiling for a *derived* cleanup delay, guarding against a misconfigured huge listSize */
const CLEANUP_DELAY_MAX_SEC = 3600;

/** hls_time driving the derived playlist-stall threshold + cleanup delay */
function pipelineSegmentSeconds(p: DesiredSession['pipeline']): number {
  return p.segmentSeconds ?? 5;
}

/** hls_list_size driving the derived cleanup delay */
function pipelineListSize(p: DesiredSession['pipeline']): number {
  return p.listSize ?? 120;
}

interface SessionEntry {
  desired: DesiredSession;
  configHash: string;
  /** null when the persisted session no longer builds (state 'invalid') */
  session: SessionLike | null;
  outDir: string | null;
  invalidError?: string;
}

/** a removal whose `rm -rf outDir` is scheduled but not yet fired */
interface PendingDeletion {
  outDir: string;
  timer: unknown;
  deadlineMs: number;
  /** identity across schedule/cancel/fire — neutralizes an already-fired stale timer */
  token: number;
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
  /** clock + timer seam for the deferred-deletion timer; default real timers */
  timers?: Timers;
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
  private readonly timers: Timers;

  /** removals awaiting a deferred `rm -rf outDir`, keyed by session name */
  private readonly pendingDeletions = new Map<string, PendingDeletion>();
  private deletionSeq = 0;

  private reconcileChain: Promise<void> = Promise.resolve();
  private reconcileQueued = false;
  private queuedResult: Promise<void> = Promise.resolve();

  constructor(deps: SupervisorDeps) {
    this.buildPipeline = deps.buildPipeline;
    this.store = deps.store;
    this.config = deps.config;
    this.logger = deps.logger ?? console;
    this.fs = deps.fs ?? fsp;
    this.timers = deps.timers ?? defaultTimers;
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
            segmentSeconds: pipelineSegmentSeconds(init.desired.pipeline),
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

  /**
   * Run `fn` serialized on the reconcile chain. Used by the deferred-deletion
   * timer, which fires OUTSIDE any reconcile but must be mutually exclusive with
   * doReconcile/createAndStart so its `rm` can never overlap a new session
   * (re)creating the same deterministic outDir.
   */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.reconcileChain.then(fn);
    this.reconcileChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Parallel graceful stop of everything (SIGTERM path). Sessions never throw on
   * stop. Any deferred deletions are flushed synchronously — the process exits
   * right after, so draining is moot and leaving them would orphan the dirs.
   */
  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((entry) => entry.session?.stop()));
    const pending = [...this.pendingDeletions.values()];
    this.pendingDeletions.clear();
    await Promise.all(
      pending.map((p) => {
        this.timers.clearTimeout(p.timer);
        return this.rmOutDir(p.outDir);
      }),
    );
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

  /**
   * Live log stream for one session. `null` = unknown session (→ 404); an
   * `invalid` session (no live Session object) yields an empty, already-ended
   * subscription — mirroring sessionLog's read convention.
   */
  subscribeSessionLog(name: string, tailLines: number, sub: LogSubscriber): LogSubscription | null {
    const entry = this.sessions.get(name);
    if (!entry) return null;
    if (!entry.session?.subscribeLog) {
      return { tail: [], live: false, unsubscribe: () => undefined };
    }
    return entry.session.subscribeLog(tailLines, sub);
  }

  /**
   * End every open log stream — called on shutdown BEFORE the HTTP server
   * closes, so `server.close()` never blocks on a long-lived SSE response.
   */
  endAllLogStreams(): void {
    for (const entry of this.sessions.values()) entry.session?.endLogStreams?.();
  }

  /** Zero one session's restarts counter. false = unknown or no live Session (→ 404). */
  resetSessionRestarts(name: string): boolean {
    const entry = this.sessions.get(name);
    if (!entry?.session?.resetRestarts) return false;
    entry.session.resetRestarts();
    return true;
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

    // a name that is desired again cancels any pending deletion of its dir — the
    // (re)created session legitimately reuses serveDir/<name> (as restart does)
    for (const name of desiredByName.keys()) this.cancelDeletion(name);

    // removed → graceful stop, then rm -rf outDir (deferred by cleanupDelaySec)
    for (const [name, entry] of [...this.sessions]) {
      if (desiredByName.has(name)) continue;
      this.logger.info(`[supervisor] session ${name} removed — stopping`);
      // end log streams at the decision to discard, not after the graceful drain
      entry.session?.endLogStreams?.();
      await entry.session?.stop();
      this.sessions.delete(name);
      if (this.config.cleanupOnRemove && entry.outDir) {
        const delayMs = this.resolveCleanupDelayMs(entry.desired);
        if (delayMs <= 0) {
          await this.rmOutDir(entry.outDir);
        } else {
          this.scheduleDeletion(name, entry.outDir, delayMs);
        }
      }
    }

    for (const [name, desired] of desiredByName) {
      const configHash = stableHash(desired);
      const existing = this.sessions.get(name);
      if (existing && existing.configHash === configHash) continue; // unchanged → NOT touched
      if (existing) {
        this.logger.info(`[supervisor] session ${name} changed — replacing`);
        existing.session?.endLogStreams?.();
        await existing.session?.stop();
        this.sessions.delete(name);
      }
      await this.createAndStart(name, desired, configHash);
    }
  }

  private async createAndStart(name: string, desired: DesiredSession, configHash: string): Promise<void> {
    // universal guard for add-back and config-change replace: the new session
    // owns serveDir/<name>, so any pending deletion of it must be disarmed first
    this.cancelDeletion(name);
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

  // ----- deferred cleanup ---------------------------------------------------

  /** Drain delay for a removed session: explicit override, or derived HLS window. */
  private resolveCleanupDelayMs(desired: DesiredSession): number {
    const cfg = this.config.cleanupDelaySec;
    if (cfg !== null) return cfg * 1000; // explicit override (0 = immediate)
    const seg = pipelineSegmentSeconds(desired.pipeline);
    const list = pipelineListSize(desired.pipeline);
    return Math.min(seg * list, CLEANUP_DELAY_MAX_SEC) * 1000;
  }

  private scheduleDeletion(name: string, outDir: string, delayMs: number): void {
    this.cancelDeletion(name); // never double-arm a name
    const token = ++this.deletionSeq;
    const deadlineMs = this.timers.now() + delayMs;
    const timer = this.timers.setTimeout(() => this.fireDeletion(name, token), delayMs);
    this.pendingDeletions.set(name, { outDir, timer, deadlineMs, token });
    this.logger.info(
      `[supervisor] session ${name} removed — cleanup of ${outDir} deferred ${Math.round(delayMs / 1000)}s`,
    );
  }

  private cancelDeletion(name: string): void {
    const pending = this.pendingDeletions.get(name);
    if (!pending) return;
    this.timers.clearTimeout(pending.timer);
    this.pendingDeletions.delete(name);
  }

  /** Timer callback — fires OUTSIDE the reconcile chain; re-enters it to rm safely. */
  private fireDeletion(name: string, token: number): void {
    void this.runExclusive(async () => {
      const pending = this.pendingDeletions.get(name);
      if (!pending || pending.token !== token) return; // cancelled or superseded
      this.pendingDeletions.delete(name);
      await this.rmOutDir(pending.outDir);
    });
  }

  private async rmOutDir(outDir: string): Promise<void> {
    await this.fs.rm(outDir, { recursive: true, force: true }).catch((err: unknown) => {
      this.logger.warn(
        `[supervisor] cleanup of ${outDir} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}
