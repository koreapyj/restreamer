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

/* Test doubles: fake ChildProcess, fake source fetch, in-memory fs, fixtures. */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { DesiredSession } from '../../src/contract/v1.js';
import type {
  BuiltPipeline,
  ChildHandle,
  FetchImpl,
  FsOps,
  Logger,
  SessionSettings,
  Timers,
} from '../../src/supervise/types.js';

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
// fake child process
// ---------------------------------------------------------------------------

export class FakeChild extends EventEmitter implements ChildHandle {
  pid: number;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  fd3 = new PassThrough();
  stdio: Array<PassThrough | null>;
  /** signals received, in order */
  killed: string[] = [];
  exitOnSigterm = true;
  exitOnSigkill = true;
  exited = false;
  /** everything written to stdin, in arrival order */
  stdinChunks: Buffer[] = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
    this.stdio = [this.stdin, this.stdout, this.stderr, this.fd3];
    // sinks so pipes never block or throw
    this.stdin.on('error', () => undefined);
    this.stdin.on('data', (chunk: Buffer) => this.stdinChunks.push(chunk));
  }

  /** all stdin bytes received so far, concatenated */
  stdinBytes(): Buffer {
    return Buffer.concat(this.stdinChunks);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal);
    if (signal === 'SIGTERM' && this.exitOnSigterm) this.exit(null, 'SIGTERM');
    if (signal === 'SIGKILL' && this.exitOnSigkill) this.exit(null, 'SIGKILL');
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }

  /** write one ffmpeg -progress block to fd3 */
  writeProgress(fields: Record<string, string> = {}): void {
    const block = { bitrate: '3000.0kbits/s', speed: '1.01x', out_time_us: '1000000', ...fields };
    let text = '';
    for (const [k, v] of Object.entries(block)) text += `${k}=${v}\n`;
    text += 'progress=continue\n';
    this.fd3.write(text);
  }

  writeStderr(line: string): void {
    this.stderr.write(`${line}\n`);
  }
}

export interface FakeSpawn {
  impl: (command: string, argv: string[], options: { stdio: Array<'pipe' | 'ignore'> }) => ChildHandle;
  /** children in spawn order — [tsreadex, ffmpeg, tsreadex, ffmpeg, …] */
  children: FakeChild[];
  calls: Array<{ command: string; argv: string[]; stdio: Array<'pipe' | 'ignore'> }>;
  /** children of the newest generation */
  tsreadex(): FakeChild;
  ffmpeg(): FakeChild;
  /** configure children created from now on */
  nextExitOnSigterm: boolean;
}

export function fakeSpawn(): FakeSpawn {
  let nextPid = 100;
  const self: FakeSpawn = {
    children: [],
    calls: [],
    nextExitOnSigterm: true,
    impl(command, argv, options) {
      const child = new FakeChild(nextPid++);
      child.exitOnSigterm = self.nextExitOnSigterm;
      self.children.push(child);
      self.calls.push({ command, argv, stdio: options.stdio });
      return child;
    },
    tsreadex() {
      const c = self.children[self.children.length - 2];
      if (!c) throw new Error('no tsreadex spawned yet');
      return c;
    },
    ffmpeg() {
      const c = self.children[self.children.length - 1];
      if (!c) throw new Error('no ffmpeg spawned yet');
      return c;
    },
  };
  return self;
}

// ---------------------------------------------------------------------------
// fake source (undici-style fetch)
// ---------------------------------------------------------------------------

export interface FakeSource {
  fetchImpl: FetchImpl;
  /** body of the newest request */
  body(): PassThrough;
  bodies: PassThrough[];
  calls: Array<{ url: string; headers: Record<string, string> }>;
  aborts: number;
  status: number;
  /** reject the next fetch outright (network error) */
  failNext?: Error;
}

export function fakeSource(status = 200): FakeSource {
  const self: FakeSource = {
    bodies: [],
    calls: [],
    aborts: 0,
    status,
    body() {
      const b = self.bodies[self.bodies.length - 1];
      if (!b) throw new Error('no source request made yet');
      return b;
    },
    fetchImpl: async (url, init) => {
      self.calls.push({ url, headers: init.headers });
      if (self.failNext) {
        const err = self.failNext;
        self.failNext = undefined;
        throw err;
      }
      const body = new PassThrough();
      body.on('error', () => undefined);
      init.signal.addEventListener('abort', () => {
        self.aborts++;
        body.destroy();
      });
      self.bodies.push(body);
      return { statusCode: self.status, body };
    },
  };
  return self;
}

// ---------------------------------------------------------------------------
// in-memory fs
// ---------------------------------------------------------------------------

export interface MemFs {
  ops: FsOps;
  files: Map<string, string>;
  mtimes: Map<string, number>;
  rmCalls: string[];
  set(path: string, content: string, mtimeMs?: number): void;
  has(path: string): boolean;
}

function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

function enoent(p: string): NodeJS.ErrnoException {
  const err = new Error(`ENOENT: no such file or directory, '${p}'`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

export function memFs(): MemFs {
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const rmCalls: string[] = [];
  return {
    files,
    mtimes,
    rmCalls,
    set(p, content, mtimeMs = Date.now()) {
      files.set(norm(p), content);
      mtimes.set(norm(p), mtimeMs);
    },
    has(p) {
      return files.has(norm(p));
    },
    ops: {
      mkdir: async () => undefined,
      writeFile: async (p, data) => {
        files.set(norm(p), data);
        mtimes.set(norm(p), Date.now());
      },
      unlink: async (p) => {
        if (!files.delete(norm(p))) throw enoent(p);
        mtimes.delete(norm(p));
      },
      readFile: async (p) => {
        const v = files.get(norm(p));
        if (v === undefined) throw enoent(p);
        return v;
      },
      stat: async (p) => {
        const m = mtimes.get(norm(p));
        if (m === undefined) throw enoent(p);
        return { mtimeMs: m };
      },
      rm: async (p) => {
        rmCalls.push(norm(p));
        const prefix = `${norm(p)}/`;
        for (const key of [...files.keys()]) {
          if (key === norm(p) || key.startsWith(prefix)) {
            files.delete(key);
            mtimes.delete(key);
          }
        }
      },
    },
  };
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

export function sampleDesired(overrides: Partial<DesiredSession> & { name?: string } = {}): DesiredSession {
  return {
    name: 'at-x',
    source: { channelUuid: 'uuid-1' },
    tsreadex: { programNumber: 1064 },
    pipeline: {
      template: 'arib-hls',
      templateVersion: 1,
      video: { mode: 'ivtc' },
      audio: [{}, {}],
    },
    ...overrides,
  };
}

export function sampleBuilt(name: string): BuiltPipeline {
  return {
    sourceUrl: `http://tvh.example:9981/stream/channel/uuid-${name}?profile=pass`,
    tsreadexArgv: ['-n', '1064', '-a', '13', '-b', '7', '-c', '5', '-u', '2', '-'],
    ffmpegArgv: ['-nostats', '-i', '-', '-progress', 'pipe:3'],
    outDir: `/media/${name}`,
    needsProgramNumber: false,
  };
}

export function sampleSettings(overrides: Partial<SessionSettings> = {}): SessionSettings {
  return {
    daemonVersion: '0.1.0',
    tsreadexPath: 'tsreadex',
    ffmpegPath: 'ffmpeg',
    stallTimeoutSec: 30,
    playlistStallSec: null,
    segmentSeconds: 5,
    memoryLimitMb: 2048,
    stopGraceSec: 10,
    logCapacity: 100,
    watchedPlaylistPath: '1080p/stream.m3u8',
    ...overrides,
  };
}

/** flush stream/microtask callbacks without advancing fake timers (setImmediate stays real) */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Injectable manual clock implementing the `Timers` seam. `tick(ms)` advances
 * the clock, fires every timer now due, then flushes microtasks so any async
 * callback (e.g. the supervisor's deferred `rm`) settles before it returns.
 * Only setTimeout/clearTimeout are modeled — the supervisor uses nothing else.
 */
export function manualTimers() {
  let now = 0;
  let seq = 0;
  const scheduled = new Map<number, { fn: () => void; at: number }>();
  const timers: Timers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      scheduled.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (h) => {
      scheduled.delete(h as number);
    },
    setInterval: () => 0,
    clearInterval: () => {},
  };
  async function tick(ms: number): Promise<void> {
    now += ms;
    for (const [id, e] of [...scheduled]) {
      if (e.at <= now) {
        scheduled.delete(id);
        e.fn();
      }
    }
    await flush();
  }
  return { timers, tick, nowMs: () => now, pending: () => scheduled.size };
}
