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
 * Shared types for the supervision layer. The pipeline builder itself lives
 * in src/pipeline/ (a parallel work package) — the supervisor only depends on
 * the injected `BuildPipeline` function and the `BuiltPipeline` shape below,
 * which must stay structurally identical to the builder's return type.
 */

import type { Readable, Writable } from 'node:stream';
import type { DesiredSession, SessionStatus } from '../contract/v1.js';
import type { LogEntry } from '../util/logRing.js';

/** What the (injected) pipeline builder produces for one session. */
export interface BuiltPipeline {
  /** fully-resolved source URL (tvh stream URL or the raw url source) */
  sourceUrl: string;
  /** tsreadex arguments (binary path comes from config via SessionSettings) */
  tsreadexArgv: string[];
  /** ffmpeg arguments (binary path comes from config via SessionSettings) */
  ffmpegArgv: string[];
  /** session output directory: `<serveDir>/<name>` (POSIX path at runtime) */
  outDir: string;
  /**
   * true when the session has no explicit `tsreadex.programNumber` — argv
   * lacks `-n`; the session PAT-probes the source and prepends it.
   */
  needsProgramNumber: boolean;
}

/** Injected builder — pure; throws on invalid params (used for dry-run validation). */
export type BuildPipeline = (session: DesiredSession) => BuiltPipeline;

// ---------------------------------------------------------------------------
// Injectable process / IO / time seams (all replaced by fakes in tests)
// ---------------------------------------------------------------------------

/** Minimal child-process surface the session needs (satisfied by node's ChildProcess). */
export interface ChildHandle {
  pid?: number | undefined;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  /** index 3 is the ffmpeg `-progress pipe:3` stream when enabled */
  stdio: ReadonlyArray<Readable | Writable | null | undefined>;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export interface SpawnOptionsLike {
  stdio: Array<'pipe' | 'ignore'>;
}

export type SpawnImpl = (command: string, argv: string[], options: SpawnOptionsLike) => ChildHandle;

/**
 * Source HTTP response — undici `request()` shape (`statusCode`) or anything
 * fetch-like that exposes `status`; `body` must be a Node Readable.
 */
export interface SourceResponse {
  statusCode?: number;
  status?: number;
  body: Readable;
}

export type FetchImpl = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<SourceResponse>;

/** Clock + timer seam so tests can drive time deterministically. */
export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Filesystem surface used by session/supervisor/store (satisfied by node:fs/promises). */
export interface FsOps {
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  stat(path: string): Promise<{ mtimeMs: number }>;
  rm(path: string, opts: { recursive: true; force: true }): Promise<void>;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** RSS sampler; real impl reads /proc/<pid>/statm, returns null off-Linux / on error. */
export type ReadRssMb = (pid: number) => Promise<number | null>;

// ---------------------------------------------------------------------------
// Session wiring
// ---------------------------------------------------------------------------

/** Per-session knobs derived from DaemonConfig + the session's pipeline params. */
export interface SessionSettings {
  /** daemon version for the stream User-Agent */
  daemonVersion: string;
  tsreadexPath: string;
  ffmpegPath: string;
  /** no ffmpeg -progress update for this long while running ⇒ stall */
  stallTimeoutSec: number;
  /** playlist PDT lag threshold; null ⇒ derive `3 × segmentSeconds + 15` */
  playlistStallSec: number | null;
  /** hls_time of this session's pipeline (drives the derived playlist threshold) */
  segmentSeconds: number;
  /** combined ffmpeg+tsreadex RSS ceiling; null ⇒ memory guard disabled */
  memoryLimitMb: number | null;
  /** graceful stop: source abort → SIGTERM after this many seconds → SIGKILL +5s */
  stopGraceSec: number;
  /** stderr ring-buffer capacity */
  logCapacity: number;
  /** media playlist watched by the output-health watchdog, relative to outDir */
  watchedPlaylistPath: string;
}

export interface SessionDeps {
  spawnImpl: SpawnImpl;
  fetchImpl: FetchImpl;
  fs: FsOps;
  timers: Timers;
  rng: () => number;
  logger: Logger;
  readRssMb: ReadRssMb;
  /** invoked after every state transition */
  onStateChange?: (state: string) => void;
}

/** What the supervisor needs from a session (the real Session or a test fake). */
export interface SessionLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): SessionStatus;
  /** newest `lines` stderr ring entries, chronological (GET /v1/sessions/:name/log); optional so test fakes stay minimal */
  logTail?(lines: number): LogEntry[];
}

export interface SessionFactoryInit {
  desired: DesiredSession;
  pipeline: BuiltPipeline;
  configHash: string;
}

export type SessionFactory = (init: SessionFactoryInit) => SessionLike;
