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
 * Hardware-free end-to-end: real Supervisor + real Fastify server on an
 * ephemeral port, real child processes (node running fixtures/fake-*.mjs —
 * the .sh fixtures are the Linux/CI counterparts; the .mjs ones keep this
 * test runnable on Windows dev machines), real temp serveDir/stateFile, and
 * a local http server streaming endless bytes as the fake tvh source.
 *
 * The only test-specific seam is a BuildPipeline decorator that prepends the
 * fixture script path to each argv while ffmpegPath/tsreadexPath point at
 * process.execPath — so `spawn(node, [fixture.mjs, ...realArgv])` runs the
 * fake binary with the genuine production argv.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Value } from '@sinclair/typebox/value';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createServer } from '../src/api/server.js';
import type { DaemonConfig } from '../src/config.js';
import { type DesiredSession, type DesiredState, SourcesResponse, StatusResponse } from '../src/contract/v1.js';
import { buildPipeline } from '../src/pipeline/build.js';
import { SourcesCatalog } from '../src/sources/catalog.js';
import { DesiredStore } from '../src/state/desiredStore.js';
import { Supervisor } from '../src/supervise/supervisor.js';
import { VERSION } from '../src/version.js';
import { silentLogger } from './support/fakes.js';

const fixturesDir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const fakeFfmpeg = path.join(fixturesDir, 'fake-ffmpeg.mjs');
const fakeTsreadex = path.join(fixturesDir, 'fake-tsreadex.mjs');

let tmpDir: string;
let serveDir: string;
let source: http.Server;
let supervisor: Supervisor;
let catalog: SourcesCatalog;
let server: FastifyInstance;
let base: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'restreamer-e2e-'));
  // forward slashes: BuiltPipeline.outDir is a POSIX-style path by contract
  serveDir = `${tmpDir.replace(/\\/g, '/')}/serve`;
  mkdirSync(serveDir, { recursive: true });

  // fake tvh: streams endless TS-sized chunks until the client disconnects
  source = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    const timer = setInterval(() => res.write(Buffer.alloc(1316)), 50);
    req.on('close', () => clearInterval(timer));
    res.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const sourcePort = (source.address() as AddressInfo).port;

  // external-sources catalog: a real temp file read by the real SourcesCatalog
  const sourcesM3u = path.join(tmpDir, 'sources.m3u');
  writeFileSync(
    sourcesM3u,
    [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="ext-1" tvg-logo="http://logo/1.png" tvg-chno="9.1",External One',
      'https://ext.example/one/index.m3u8',
      '#EXTINF:-1 tvg-chno="9.2",External Two',
      'https://ext.example/two/index.m3u8',
      '',
    ].join('\n'),
    'utf8',
  );

  const config: DaemonConfig = {
    listen: { host: '127.0.0.1', port: 0 },
    serveDir,
    stateFile: `${tmpDir.replace(/\\/g, '/')}/state/desired.json`,
    tvhBaseUrl: `http://127.0.0.1:${sourcePort}`,
    sourcesM3u,
    defaultWeight: 100,
    ffmpegPath: process.execPath,
    tsreadexPath: process.execPath,
    capabilities: ['qsv', 'opencl'],
    logLines: 200,
    stallTimeoutSec: 30,
    playlistStallSec: null,
    memoryLimitMb: null,
    stopGraceSec: 2,
    cleanupOnRemove: true,
  };

  supervisor = new Supervisor({
    // A2's real builder, decorated: fixture script prepended so
    // spawn(process.execPath, argv) executes the fake binary
    buildPipeline: (session: DesiredSession) => {
      const built = buildPipeline(session, {
        serveDir: config.serveDir,
        tvhBaseUrl: config.tvhBaseUrl,
        defaultWeight: config.defaultWeight,
        progress: true,
      });
      return {
        ...built,
        tsreadexArgv: [fakeTsreadex, ...built.tsreadexArgv],
        ffmpegArgv: [fakeFfmpeg, ...built.ffmpegArgv],
      };
    },
    store: new DesiredStore(config.stateFile, silentLogger),
    config,
    logger: silentLogger,
    daemonVersion: 'e2e',
  });
  await supervisor.startFromDisk();

  catalog = new SourcesCatalog(config.sourcesM3u, { logger: silentLogger });
  await catalog.start();

  server = createServer({ supervisor, config, catalog, logger: silentLogger });
  await server.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
}, 20_000);

afterAll(async () => {
  catalog?.stop();
  await server?.close();
  await supervisor?.stopAll();
  await new Promise<void>((resolve) => source?.close(() => resolve()));
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows can hold handles briefly; leaked temp dirs are harmless
  }
}, 20_000);

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${url}`);
  return { status: res.status, body: await res.json() };
}

async function putDesired(doc: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}/v1/desired`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(doc),
  });
  return { status: res.status, body: await res.json() };
}

async function pollStatus(
  pred: (status: StatusResponse) => boolean,
  what: string,
  timeoutMs = 15_000,
): Promise<StatusResponse> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { status, body } = await getJson('/v1/status');
    expect(status).toBe(200);
    expect(Value.Check(StatusResponse, body), 'GET /v1/status must match the wire contract').toBe(true);
    const parsed = body as StatusResponse;
    if (pred(parsed)) return parsed;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; sessions: ${JSON.stringify(parsed.sessions)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

function desiredDoc(revision: string, sessions: DesiredSession[]): DesiredState {
  return { apiVersion: 1, revision, sessions };
}

const e2eSession: DesiredSession = {
  name: 'e2e',
  // channelUuid source → the fake tvh server via tvhBaseUrl
  source: { channelUuid: 'test-uuid', weight: 42 },
  tsreadex: { programNumber: 333 },
  pipeline: {
    template: 'arib-hls',
    templateVersion: 1,
    video: { mode: 'none' },
    audio: [{}],
    subtitles: { enabled: false },
    thumbnail: { enabled: false },
  },
};

test.sequential(
  'daemon e2e: PUT desired → running → log → restart → remove',
  async () => {
    // fresh daemon: healthz up, contract-valid empty status, no desired doc
    expect((await getJson('/v1/healthz')).body).toEqual({ ok: true });
    const empty = await pollStatus(() => true, 'initial status');
    expect(empty.sessions).toEqual([]);
    expect(empty.desiredRevision).toBeNull();
    expect(empty.daemonVersion).toBe(VERSION);
    expect(empty.templates).toEqual([{ id: 'arib-hls', version: 1 }]);
    expect((await getJson('/v1/desired')).status).toBe(404);

    // rejected PUTs: wrong apiVersion, schema violation, dry-run build failure
    const badVersion = await putDesired({ ...desiredDoc('r0', []), apiVersion: 2 });
    expect(badVersion.status).toBe(400);
    expect((badVersion.body as { error: string }).error).toMatch(/apiVersion/);
    const badSchema = await putDesired({ apiVersion: 1, revision: 'r0', sessions: [{ name: 'UPPER' }] });
    expect(badSchema.status).toBe(400);
    const badApply = await putDesired(desiredDoc('r0', [e2eSession, e2eSession])); // schema-valid, rejected by applyDesired
    expect(badApply.status).toBe(400);
    expect((badApply.body as { error: string; details: string }).details).toMatch(/duplicate session name/);
    expect((await getJson('/v1/desired')).status).toBe(404); // nothing applied

    // accept one session and watch it come up on real (fake-binary) processes
    const put = await putDesired(desiredDoc('rev-1', [e2eSession]));
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ accepted: true, revision: 'rev-1' });

    const running = await pollStatus(
      (s) => s.sessions[0]?.state === 'running' && s.sessions[0].progress !== undefined,
      'session running with ffmpeg progress',
    );
    expect(running.desiredRevision).toBe('rev-1');
    expect(running.sessions[0]?.ffmpegPid).toBeGreaterThan(0);
    expect(running.sessions[0]?.tsreadexPid).toBeGreaterThan(0);
    expect(existsSync(path.join(serveDir, 'e2e', '1080p', 'stream.m3u8'))).toBe(true);

    // desired read-back
    const desired = await getJson('/v1/desired');
    expect(desired.status).toBe(200);
    expect((desired.body as DesiredState).revision).toBe('rev-1');

    // stderr ring tail
    const log = await getJson('/v1/sessions/e2e/log?lines=50');
    expect(log.status).toBe(200);
    const lines = (log.body as { name: string; lines: Array<{ ts: string; src: string; line: string }> }).lines;
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => typeof l.ts === 'string' && typeof l.line === 'string')).toBe(true);
    expect((await getJson('/v1/sessions/nope/log')).status).toBe(404);

    // restart: kill + respawn, back to running with restarts bumped
    expect((await fetch(`${base}/v1/sessions/nope/restart`, { method: 'POST' })).status).toBe(404);
    const restart = await fetch(`${base}/v1/sessions/e2e/restart`, { method: 'POST' });
    expect(restart.status).toBe(200);
    expect(await restart.json()).toEqual({ ok: true });
    await pollStatus(
      (s) => s.sessions[0]?.state === 'running' && s.sessions[0].restarts >= 1,
      'session running again after restart',
    );

    // full-replacement PUT without the session → stopped, cleaned up, empty status
    const removal = await putDesired(desiredDoc('rev-2', []));
    expect(removal.status).toBe(200);
    const cleared = await pollStatus((s) => s.sessions.length === 0, 'session removed');
    expect(cleared.desiredRevision).toBe('rev-2');
    expect(existsSync(path.join(serveDir, 'e2e'))).toBe(false); // cleanupOnRemove
    expect(((await getJson('/v1/desired')).body as DesiredState).revision).toBe('rev-2');
  },
  30_000,
);

test.sequential('daemon e2e: GET /v1/sources serves the local catalog; status carries its hash', async () => {
  const { status, body } = await getJson('/v1/sources');
  expect(status).toBe(200);
  expect(Value.Check(SourcesResponse, body), 'GET /v1/sources must match the wire contract').toBe(true);
  const sources = body as SourcesResponse;

  expect(sources.catalogHash).toBeTypeOf('string'); // non-null: a catalog is configured
  expect(sources.updatedAt).toBeTypeOf('string');
  expect(sources.warnings).toBeUndefined();
  expect(sources.entries).toEqual([
    {
      id: 'ext-1',
      name: 'External One',
      url: 'https://ext.example/one/index.m3u8',
      logo: 'http://logo/1.png',
      chno: '9.1',
    },
    // no tvg-id → slug of the display name
    { id: 'external-two', name: 'External Two', url: 'https://ext.example/two/index.m3u8', chno: '9.2' },
  ]);

  const statusBody = await pollStatus(() => true, 'status with sourcesHash');
  expect(statusBody.sourcesHash).toBe(sources.catalogHash);
});
