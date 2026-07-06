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
 * One session's lifecycle state machine:
 *
 *   idle → starting → running → (stopping → stopped | backoff → starting)
 *   plus `disabled` (enabled:false — never spawns, keeps config + dir).
 *
 * A generation = one source fetch + one tsreadex + one ffmpeg. The source is
 * streamed via injected fetch (HTTP status visibility distinguishes
 * "subscription refused" from a mid-stream drop); body→tsreadex.stdin,
 * tsreadex.stdout→ffmpeg.stdin, ffmpeg -progress on fd3.
 *
 * Sessions without an explicit `tsreadex.programNumber`
 * (pipeline.needsProgramNumber) PAT-probe the source between source-open and
 * spawn: chunks are buffered losslessly while a PatProbe scans them; on
 * success tsreadex is spawned with `-n <detected>` prepended and the buffered
 * prefix is written to its stdin before the body is piped (byte order
 * preserved). Probe failure (2MiB/10s bound, source end, abort) tears the
 * generation down as a `crash`.
 *
 * All public transitions are serialized through a promise-chain mutex.
 * Watchdog-initiated restarts (stall / playlist-lag / oom-guard) tear the
 * generation down and flow through the normal exit path, which classifies
 * the exit and schedules the next start. The session never gives up.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { request as undiciRequest } from 'undici';
import type { DesiredSession, ExitClass, SessionState, SessionStatus } from '../contract/v1.js';
import { PatProbe, pickProgram } from '../pipeline/patProbe.js';
import { type LogEntry, LogRing } from '../util/logRing.js';
import { backoffDelayMs } from './backoff.js';
import type {
  BuiltPipeline,
  ChildHandle,
  FetchImpl,
  SessionDeps,
  SessionSettings,
  SpawnImpl,
  Timers,
} from './types.js';

export type InternalSessionState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'backoff'
  | 'disabled';

/** healthy / oom-guard exits restart quickly instead of consulting the backoff schedule */
export const QUICK_RESTART_MS = 1_000;

/** PAT probe bounds — no PAT within either bound fails the generation (class crash) */
export const PAT_PROBE_MAX_BYTES = 2 * 1024 * 1024;
export const PAT_PROBE_TIMEOUT_MS = 10_000;

const PAT_PROBE_FAIL_MSG =
  'no PAT found in the first 2MiB/10s of the source — cannot derive a program number; set a manual programNumber override';

const RAN_HEALTHY_MS = 60_000;
const HEALTH_FILE_INTERVAL_MS = 5_000;
const PLAYLIST_CHECK_INTERVAL_MS = 15_000;
const MEMORY_CHECK_INTERVAL_MS = 10_000;
const SIGKILL_AFTER_MS = 5_000;

export const DEFAULT_WATCHED_PLAYLIST = '1080p/stream.m3u8';

interface Generation {
  abort: AbortController;
  body?: Readable;
  tsreadex?: ChildHandle;
  ffmpeg?: ChildHandle;
  startedAtMs: number;
  startedAtIso: string;
  producedProgress: boolean;
  /** source body ended on its own (not via our abort) */
  sourceEnded: boolean;
  /** watchdog-assigned class overriding exit classification */
  pendingClass?: ExitClass;
  lastStderr?: string;
  exitedTsreadex: boolean;
  exitedFfmpeg: boolean;
  ffmpegExit?: { code: number | null; signal: string | null };
  /** intentional stop — do not reschedule */
  stopping: boolean;
  /** teardown of the counterpart child already initiated */
  tearingDown: boolean;
  stopResolve?: () => void;
  finished: boolean;
  progressBlock: Record<string, string>;
  timers: unknown[];
  stallTimer?: unknown;
}

const defaultTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

const defaultSpawn: SpawnImpl = (command, argv, options) =>
  nodeSpawn(command, argv, { stdio: options.stdio }) as unknown as ChildHandle;

const defaultFetch: FetchImpl = async (url, init) => {
  const res = await undiciRequest(url, { method: 'GET', headers: init.headers, signal: init.signal });
  return { statusCode: res.statusCode, body: res.body as unknown as Readable };
};

/** Linux page size on every platform we deploy to. */
const PAGE_SIZE = 4096;

/** Real RSS sampler: /proc/<pid>/statm field 2 × page size. Null off-Linux or on error. */
export async function readRssMbLinux(pid: number): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  try {
    const text = await fsp.readFile(`/proc/${pid}/statm`, 'utf8');
    const rssPages = Number(text.trim().split(/\s+/)[1]);
    if (!Number.isFinite(rssPages)) return null;
    return (rssPages * PAGE_SIZE) / (1024 * 1024);
  } catch {
    return null;
  }
}

export interface SessionInit {
  desired: DesiredSession;
  pipeline: BuiltPipeline;
  configHash: string;
  settings: SessionSettings;
  deps?: Partial<SessionDeps>;
}

export class Session {
  readonly name: string;
  readonly desired: DesiredSession;
  readonly pipeline: BuiltPipeline;
  readonly configHash: string;
  readonly logRing: LogRing;

  private readonly settings: SessionSettings;
  private readonly deps: SessionDeps;

  private internalState: InternalSessionState = 'idle';
  private gen: Generation | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  /** false once stop() is requested — a stale retry must not resurrect the session */
  private wantRunning = false;
  private everStarted = false;

  private restarts = 0;
  private consecutiveFailures = 0;
  private nextRetryAt: string | undefined;
  private retryTimer: unknown;
  private lastExit: SessionStatus['lastExit'];
  private lastError: string | undefined;
  private progress: SessionStatus['progress'];
  private memoryRssMb: number | undefined;
  private lastSegmentAt: string | undefined;
  private playlistLagSec: number | undefined;
  /** PAT-probed program number — kept across restarts until a new probe result */
  private detectedProgramNumber: number | undefined;
  /** aborts an in-flight PAT probe (stop() must not wait out the probe timeout) */
  private probeCancel: (() => void) | undefined;

  constructor(init: SessionInit) {
    this.desired = init.desired;
    this.name = init.desired.name;
    this.pipeline = init.pipeline;
    this.configHash = init.configHash;
    this.settings = init.settings;
    this.deps = {
      spawnImpl: defaultSpawn,
      fetchImpl: defaultFetch,
      fs: fsp,
      timers: defaultTimers,
      rng: Math.random,
      logger: console,
      readRssMb: readRssMbLinux,
      ...init.deps,
    };
    this.logRing = new LogRing(this.settings.logCapacity);
  }

  get state(): InternalSessionState {
    return this.internalState;
  }

  get enabled(): boolean {
    return this.desired.enabled !== false;
  }

  start(): Promise<void> {
    this.wantRunning = true;
    return this.enqueue(() => this.doStart());
  }

  /** Graceful stop: abort source → EOF cascade → SIGTERM → SIGKILL. Never throws. */
  stop(): Promise<void> {
    this.wantRunning = false;
    // a doStart() awaiting the PAT probe holds the mutex — cancel it so the
    // queued doStop() doesn't wait out the probe timeout
    this.probeCancel?.();
    return this.enqueue(() => this.doStop());
  }

  /** Kill + respawn with the failure counter (and thus backoff) reset. */
  restart(): Promise<void> {
    this.wantRunning = true;
    this.consecutiveFailures = 0;
    return this.enqueue(async () => {
      await this.doStop();
      await this.doStart();
    });
  }

  /** newest `lines` stderr ring entries in chronological order (GET /v1/sessions/:name/log) */
  logTail(lines: number): LogEntry[] {
    return this.logRing.tail(lines);
  }

  status(): SessionStatus {
    return {
      name: this.name,
      state: this.wireState(),
      enabled: this.enabled,
      configHash: this.configHash,
      ffmpegPid: this.gen?.ffmpeg?.pid,
      tsreadexPid: this.gen?.tsreadex?.pid,
      startedAt: this.gen?.startedAtIso,
      restarts: this.restarts,
      consecutiveFailures: this.consecutiveFailures,
      nextRetryAt: this.nextRetryAt,
      lastExit: this.lastExit,
      lastError: this.lastError,
      progress: this.progress,
      memoryRssMb: this.memoryRssMb,
      lastSegmentAt: this.lastSegmentAt,
      playlistLagSec: this.playlistLagSec,
      detectedProgramNumber: this.detectedProgramNumber,
    };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * The wire contract has no 'idle'/'stopped': 'idle' only exists before the
   * supervisor's first start() (report as starting), and 'stopped' only for
   * sessions about to be discarded or after shutdown (report as disabled).
   */
  private wireState(): SessionState {
    if (this.internalState === 'idle') return 'starting';
    if (this.internalState === 'stopped') return 'disabled';
    return this.internalState;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private setState(state: InternalSessionState): void {
    if (this.internalState === state) return;
    this.internalState = state;
    this.deps.onStateChange?.(state);
  }

  private iso(ms = this.deps.timers.now()): string {
    return new Date(ms).toISOString();
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) {
      this.deps.timers.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.nextRetryAt = undefined;
  }

  private restingState(): InternalSessionState {
    return this.enabled ? 'stopped' : 'disabled';
  }

  private async doStart(): Promise<void> {
    if (!this.wantRunning) return;
    if (this.gen) return; // already running
    if (!this.enabled) {
      this.setState('disabled');
      return;
    }
    this.clearRetry();
    this.setState('starting');
    if (this.everStarted) this.restarts++;
    this.everStarted = true;

    const t = this.deps.timers;
    const gen: Generation = {
      abort: new AbortController(),
      startedAtMs: t.now(),
      startedAtIso: this.iso(),
      producedProgress: false,
      sourceEnded: false,
      exitedTsreadex: false,
      exitedFfmpeg: false,
      stopping: false,
      tearingDown: false,
      finished: false,
      progressBlock: {},
      timers: [],
    };
    this.gen = gen;

    // --- open the source stream ---------------------------------------------
    try {
      await this.deps.fs.mkdir(this.pipeline.outDir, { recursive: true });
      const res = await this.deps.fetchImpl(this.pipeline.sourceUrl, {
        headers: { 'User-Agent': `tvhc-restreamer/${this.settings.daemonVersion} (${this.name})` },
        signal: gen.abort.signal,
      });
      const status = res.statusCode ?? res.status ?? 0;
      if (status < 200 || status >= 300) {
        res.body.destroy();
        throw new Error(`source HTTP ${status}`);
      }
      gen.body = res.body;
    } catch (err) {
      this.gen = undefined;
      if (!this.wantRunning) {
        this.setState(this.restingState());
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(`[${this.name}] source open failed: ${msg}`);
      this.lastExit = { code: null, signal: null, at: this.iso(), class: 'source-http' };
      this.lastError = msg;
      this.scheduleRestart('source-http');
      return;
    }

    // --- PAT probe (no explicit programNumber) --------------------------------
    let probedPrefix: Buffer[] | undefined;
    if (this.pipeline.needsProgramNumber) {
      const prefix = await this.probePat(gen);
      if (prefix === null) {
        gen.abort.abort();
        gen.body.destroy();
        this.gen = undefined;
        if (!this.wantRunning) {
          this.setState(this.restingState());
          return;
        }
        this.deps.logger.warn(`[${this.name}] ${PAT_PROBE_FAIL_MSG}`);
        this.lastExit = { code: null, signal: null, at: this.iso(), class: 'crash' };
        this.lastError = PAT_PROBE_FAIL_MSG;
        this.scheduleRestart('crash');
        return;
      }
      probedPrefix = prefix;
    }
    const tsreadexArgv =
      probedPrefix !== undefined && this.detectedProgramNumber !== undefined
        ? ['-n', String(this.detectedProgramNumber), ...this.pipeline.tsreadexArgv]
        : this.pipeline.tsreadexArgv;

    // --- spawn children -------------------------------------------------------
    try {
      gen.tsreadex = this.deps.spawnImpl(this.settings.tsreadexPath, tsreadexArgv, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      gen.ffmpeg = this.deps.spawnImpl(this.settings.ffmpegPath, this.pipeline.ffmpegArgv, {
        stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.logger.error(`[${this.name}] spawn failed: ${msg}`);
      gen.abort.abort();
      gen.body.destroy();
      if (gen.tsreadex) gen.tsreadex.kill('SIGKILL');
      this.gen = undefined;
      this.lastExit = { code: null, signal: null, at: this.iso(), class: 'crash' };
      this.lastError = msg;
      this.scheduleRestart('crash');
      return;
    }

    this.wireGeneration(gen, probedPrefix);
    this.setState('running');
    this.startWatchdogs(gen);
  }

  /**
   * Buffer source chunks (losslessly) while scanning for a PAT. Resolves with
   * the buffered prefix on success — `detectedProgramNumber` updated and the
   * body paused, ready to be piped after the prefix — or null on failure
   * (byte/time bound, source end/error, abort, stop()). All listeners and the
   * timeout are detached before resolving; the caller owns the teardown.
   */
  private probePat(gen: Generation): Promise<Buffer[] | null> {
    const body = gen.body as Readable;
    const probe = new PatProbe();
    const buffered: Buffer[] = [];
    const t = this.deps.timers;
    body.on('error', () => undefined); // never let a probe-window error go unhandled
    return new Promise((resolve) => {
      let settled = false;
      let timeout: unknown;
      const finish = (result: Buffer[] | null): void => {
        if (settled) return;
        settled = true;
        body.off('data', onData);
        body.off('end', onEndOrError);
        body.off('close', onEndOrError);
        body.off('error', onEndOrError);
        gen.abort.signal.removeEventListener('abort', onAbort);
        if (timeout !== undefined) t.clearTimeout(timeout);
        this.probeCancel = undefined;
        body.pause();
        resolve(result);
      };
      const onData = (chunk: Buffer): void => {
        buffered.push(chunk);
        const programs = probe.feed(chunk);
        if (programs !== null) {
          this.detectedProgramNumber = pickProgram(programs, this.deps.logger, this.name);
          finish(buffered);
          return;
        }
        if (probe.bytesConsumed >= PAT_PROBE_MAX_BYTES) finish(null);
      };
      const onEndOrError = (): void => finish(null);
      const onAbort = (): void => finish(null);
      this.probeCancel = () => finish(null);
      timeout = t.setTimeout(() => finish(null), PAT_PROBE_TIMEOUT_MS);
      gen.abort.signal.addEventListener('abort', onAbort);
      body.on('data', onData);
      body.on('end', onEndOrError);
      body.on('close', onEndOrError);
      body.on('error', onEndOrError);
    });
  }

  private wireGeneration(gen: Generation, probedPrefix?: Buffer[]): void {
    const body = gen.body as Readable;
    const tsreadex = gen.tsreadex as ChildHandle;
    const ffmpeg = gen.ffmpeg as ChildHandle;

    const markSourceEnded = () => {
      if (!gen.abort.signal.aborted) gen.sourceEnded = true;
    };
    body.on('end', markSourceEnded);
    body.on('close', markSourceEnded);
    body.on('error', () => undefined);

    if (tsreadex.stdin) {
      tsreadex.stdin.on('error', () => undefined);
      // probed bytes first, then the live body — byte order preserved (the
      // body was paused by the probe; pipe() resumes it)
      if (probedPrefix) {
        for (const chunk of probedPrefix) tsreadex.stdin.write(chunk);
      }
      body.pipe(tsreadex.stdin);
    }
    if (ffmpeg.stdin) {
      ffmpeg.stdin.on('error', () => undefined);
      tsreadex.stdout?.pipe(ffmpeg.stdin);
    }
    tsreadex.stdout?.on('error', () => undefined);

    if (tsreadex.stderr) this.hookStderr(gen, tsreadex.stderr, 'tsreadex');
    if (ffmpeg.stderr) this.hookStderr(gen, ffmpeg.stderr, 'ffmpeg');

    // fd3 = ffmpeg -progress pipe:3 (a readable pipe; Node exposes fd>2 pipes as duplex sockets)
    const progressStream = ffmpeg.stdio[3] as Readable | undefined;
    if (progressStream && typeof progressStream.on === 'function') this.hookProgress(gen, progressStream);

    tsreadex.on('exit', (code, signal) => this.onChildExit(gen, 'tsreadex', code, signal));
    ffmpeg.on('exit', (code, signal) => this.onChildExit(gen, 'ffmpeg', code, signal));
    tsreadex.on('error', (err) => this.onChildError(gen, 'tsreadex', err));
    ffmpeg.on('error', (err) => this.onChildError(gen, 'ffmpeg', err));
  }

  private onLines(stream: Readable, cb: (line: string) => void): void {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.length > 0) cb(line);
      }
    });
    stream.on('error', () => undefined);
  }

  private hookStderr(gen: Generation, stream: Readable, src: 'ffmpeg' | 'tsreadex'): void {
    this.onLines(stream, (line) => {
      gen.lastStderr = line;
      this.logRing.push({ ts: this.iso(), src, line });
      this.deps.logger.info(`[${this.name}] ${src}: ${line}`);
    });
  }

  /** ffmpeg `-progress pipe:3`: key=value lines, block ends at `progress=continue|end`. */
  private hookProgress(gen: Generation, stream: Readable): void {
    this.onLines(stream, (line) => {
      const eq = line.indexOf('=');
      if (eq < 0) return;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key !== 'progress') {
        gen.progressBlock[key] = value;
        return;
      }
      // end of block
      const bitrate = Number.parseFloat(gen.progressBlock['bitrate'] ?? '');
      const speed = Number.parseFloat(gen.progressBlock['speed'] ?? '');
      const outTimeUs = Number(gen.progressBlock['out_time_us'] ?? Number.NaN);
      this.progress = {
        bitrateKbps: Number.isFinite(bitrate) ? bitrate : 0,
        speed: Number.isFinite(speed) ? speed : 0,
        outTimeMs: Number.isFinite(outTimeUs) ? outTimeUs / 1000 : 0,
        updatedAt: this.iso(),
      };
      gen.progressBlock = {};
      gen.producedProgress = true;
      this.armStallTimer(gen);
    });
  }

  // --- watchdogs --------------------------------------------------------------

  private startWatchdogs(gen: Generation): void {
    const t = this.deps.timers;

    // health file: ISO-8601 UTC line rewritten every 5s while running
    const writeHealth = () => {
      void this.deps.fs
        .writeFile(path.posix.join(this.pipeline.outDir, 'health'), `${this.iso()}\n`)
        .catch(() => undefined);
    };
    writeHealth();
    gen.timers.push(t.setInterval(writeHealth, HEALTH_FILE_INTERVAL_MS));

    // stall watchdog: no -progress update for stallTimeoutSec ⇒ stall
    this.armStallTimer(gen);

    // output-health watchdog: playlist PDT lag
    gen.timers.push(t.setInterval(() => void this.checkPlaylist(gen), PLAYLIST_CHECK_INTERVAL_MS));

    // memory guard
    gen.timers.push(t.setInterval(() => void this.checkMemory(gen), MEMORY_CHECK_INTERVAL_MS));
  }

  private armStallTimer(gen: Generation): void {
    const t = this.deps.timers;
    if (gen.stallTimer !== undefined) t.clearTimeout(gen.stallTimer);
    if (gen.finished || gen.stopping) return;
    gen.stallTimer = t.setTimeout(() => {
      this.deps.logger.warn(`[${this.name}] no ffmpeg progress for ${this.settings.stallTimeoutSec}s — restarting`);
      this.triggerRestart(gen, 'stall', false);
    }, this.settings.stallTimeoutSec * 1000);
  }

  private playlistStallThresholdSec(): number {
    return this.settings.playlistStallSec ?? 3 * this.settings.segmentSeconds + 15;
  }

  private async checkPlaylist(gen: Generation): Promise<void> {
    if (this.gen !== gen || gen.stopping || gen.finished) return;
    const playlistPath = path.posix.join(this.pipeline.outDir, this.settings.watchedPlaylistPath);
    let lastMs: number | undefined;
    try {
      const text = await this.deps.fs.readFile(playlistPath, 'utf8');
      const matches = text.match(/#EXT-X-PROGRAM-DATE-TIME:(.+)/g);
      const last = matches?.[matches.length - 1];
      if (last) {
        const parsed = Date.parse(last.slice('#EXT-X-PROGRAM-DATE-TIME:'.length).trim());
        if (Number.isFinite(parsed)) lastMs = parsed;
      }
      if (lastMs === undefined) {
        lastMs = (await this.deps.fs.stat(playlistPath)).mtimeMs;
      }
    } catch {
      return; // playlist not there yet — the progress stall watchdog covers startup
    }
    this.lastSegmentAt = this.iso(lastMs);
    const lagSec = (this.deps.timers.now() - lastMs) / 1000;
    this.playlistLagSec = lagSec;
    if (this.internalState === 'running' && gen.producedProgress && lagSec > this.playlistStallThresholdSec()) {
      this.deps.logger.warn(
        `[${this.name}] playlist lag ${lagSec.toFixed(1)}s > ${this.playlistStallThresholdSec()}s — restarting`,
      );
      this.triggerRestart(gen, 'stall', false);
    }
  }

  private async checkMemory(gen: Generation): Promise<void> {
    if (this.gen !== gen || gen.stopping || gen.finished) return;
    const pids = [gen.ffmpeg?.pid, gen.tsreadex?.pid].filter((p): p is number => typeof p === 'number');
    let sum = 0;
    let sampled = false;
    for (const pid of pids) {
      const rss = await this.deps.readRssMb(pid);
      if (rss !== null) {
        sum += rss;
        sampled = true;
      }
    }
    if (!sampled) return;
    this.memoryRssMb = sum;
    if (this.settings.memoryLimitMb !== null && sum > this.settings.memoryLimitMb) {
      this.deps.logger.warn(
        `[${this.name}] RSS ${sum.toFixed(0)}MB > ${this.settings.memoryLimitMb}MB — proactive oom-guard restart`,
      );
      this.triggerRestart(gen, 'oom-guard', true);
    }
  }

  // --- teardown / exit --------------------------------------------------------

  /** Watchdog teardown; the exit cascade classifies via pendingClass and reschedules. */
  private triggerRestart(gen: Generation, cls: ExitClass, graceful: boolean): void {
    if (this.gen !== gen || gen.stopping || gen.finished || gen.pendingClass !== undefined) return;
    gen.pendingClass = cls;
    gen.tearingDown = true;
    gen.abort.abort();
    gen.body?.destroy();
    const t = this.deps.timers;
    if (graceful) {
      gen.timers.push(
        t.setTimeout(() => this.killChildren(gen, 'SIGTERM'), this.settings.stopGraceSec * 1000),
      );
      gen.timers.push(
        t.setTimeout(() => this.killChildren(gen, 'SIGKILL'), this.settings.stopGraceSec * 1000 + SIGKILL_AFTER_MS),
      );
    } else {
      this.killChildren(gen, 'SIGTERM');
      gen.timers.push(t.setTimeout(() => this.killChildren(gen, 'SIGKILL'), SIGKILL_AFTER_MS));
    }
  }

  private killChildren(gen: Generation, signal: NodeJS.Signals): void {
    if (gen.finished) return;
    if (gen.tsreadex && !gen.exitedTsreadex) {
      try {
        gen.tsreadex.kill(signal);
      } catch {
        /* already gone */
      }
    }
    if (gen.ffmpeg && !gen.exitedFfmpeg) {
      try {
        gen.ffmpeg.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }

  private onChildError(gen: Generation, which: 'ffmpeg' | 'tsreadex', err: Error): void {
    this.deps.logger.error(`[${this.name}] ${which} error: ${err.message}`);
    gen.lastStderr = gen.lastStderr ?? err.message;
    this.onChildExit(gen, which, null, null);
  }

  private onChildExit(
    gen: Generation,
    which: 'ffmpeg' | 'tsreadex',
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (gen.finished) return;
    if (which === 'tsreadex') {
      if (gen.exitedTsreadex) return;
      gen.exitedTsreadex = true;
    } else {
      if (gen.exitedFfmpeg) return;
      gen.exitedFfmpeg = true;
      gen.ffmpegExit = { code, signal };
    }
    // first unexpected child exit → tear the rest of the generation down
    if (!gen.stopping && !gen.tearingDown) {
      gen.tearingDown = true;
      gen.abort.abort();
      gen.body?.destroy();
      this.killChildren(gen, 'SIGTERM');
      gen.timers.push(this.deps.timers.setTimeout(() => this.killChildren(gen, 'SIGKILL'), SIGKILL_AFTER_MS));
    }
    const tsreadexDone = gen.exitedTsreadex || gen.tsreadex === undefined;
    const ffmpegDone = gen.exitedFfmpeg || gen.ffmpeg === undefined;
    if (tsreadexDone && ffmpegDone) this.finishGeneration(gen);
  }

  private finishGeneration(gen: Generation): void {
    if (gen.finished) return;
    gen.finished = true;
    const t = this.deps.timers;
    for (const handle of gen.timers) {
      t.clearTimeout(handle);
      t.clearInterval(handle);
    }
    if (gen.stallTimer !== undefined) t.clearTimeout(gen.stallTimer);
    gen.abort.abort();
    gen.body?.destroy();
    void this.deps.fs.unlink(path.posix.join(this.pipeline.outDir, 'health')).catch(() => undefined);
    if (this.gen === gen) this.gen = undefined;

    if (gen.stopping) {
      gen.stopResolve?.();
      return; // doStop() sets the final state
    }

    const cls = this.classifyExit(gen);
    this.lastExit = {
      code: gen.ffmpegExit?.code ?? null,
      signal: gen.ffmpegExit?.signal ?? null,
      at: this.iso(),
      class: cls,
    };
    if (cls === 'source-http') {
      this.lastError = gen.lastStderr ?? 'source stream ended before ffmpeg produced output';
    } else if (gen.lastStderr !== undefined) {
      this.lastError = gen.lastStderr;
    }
    this.scheduleRestart(cls);
  }

  private classifyExit(gen: Generation): ExitClass {
    if (gen.pendingClass !== undefined) return gen.pendingClass;
    if (gen.sourceEnded && !gen.producedProgress) return 'source-http';
    const ranMs = this.deps.timers.now() - gen.startedAtMs;
    if (ranMs >= RAN_HEALTHY_MS && gen.producedProgress) return 'healthy';
    return 'crash';
  }

  private scheduleRestart(cls: ExitClass): void {
    if (!this.wantRunning) {
      this.setState(this.restingState());
      return;
    }
    let delay: number;
    if (cls === 'healthy' || cls === 'oom-guard') {
      this.consecutiveFailures = 0;
      delay = QUICK_RESTART_MS;
    } else {
      this.consecutiveFailures++;
      delay = backoffDelayMs(this.consecutiveFailures, cls, this.deps.rng);
    }
    this.setState('backoff');
    this.nextRetryAt = this.iso(this.deps.timers.now() + delay);
    this.retryTimer = this.deps.timers.setTimeout(() => {
      this.retryTimer = undefined;
      this.nextRetryAt = undefined;
      void this.enqueue(() => this.doStart());
    }, delay);
  }

  private async doStop(): Promise<void> {
    this.clearRetry();
    const gen = this.gen;
    if (!gen || gen.finished) {
      this.gen = undefined;
      this.setState(this.restingState());
      return;
    }
    gen.stopping = true;
    this.setState('stopping');
    const done = new Promise<void>((resolve) => {
      gen.stopResolve = resolve;
    });
    // 1) abort the source → EOF cascade lets ffmpeg flush final segments
    gen.abort.abort();
    gen.body?.destroy();
    // 2) escalate: SIGTERM after stopGraceSec, SIGKILL 5s later
    const t = this.deps.timers;
    gen.timers.push(t.setTimeout(() => this.killChildren(gen, 'SIGTERM'), this.settings.stopGraceSec * 1000));
    gen.timers.push(
      t.setTimeout(() => this.killChildren(gen, 'SIGKILL'), this.settings.stopGraceSec * 1000 + SIGKILL_AFTER_MS),
    );
    await done;
    this.setState(this.restingState());
  }
}
