/*
 * Route-level tests via fastify.inject: PUT /v1/desired validation +
 * persistence, /v1/status contract shape, manual switch, and the /hls
 * serving routes (content-type, CORS, no-store, 404/503 paths).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SwitcherStatus, type SwitcherChannelStatus } from '../../src/contract/v1.js';
import { SwitcherStore } from '../../src/switcher/desiredStore.js';
import { buildServer } from '../../src/switcher/server.js';
import { Stitcher } from '../../src/switcher/stitch.js';
import { NODE_A, NODE_B, T0, desiredDoc, liveUpstream, makeFetch, type FakeNet } from './fixtures.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe('switcher server', () => {
  let dir: string;
  let store: SwitcherStore;
  let net: FakeNet;
  let clock: { nowMs: number };
  let stitcher: Stitcher;
  let app: FastifyInstance;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'switcher-server-test-'));
    store = new SwitcherStore(join(dir, 'desired.json'), silent);
    clock = { nowMs: T0 + 1000 };
    net = makeFetch();
    liveUpstream(net, NODE_A, clock);
    liveUpstream(net, NODE_B, clock);
    stitcher = new Stitcher({
      cacheTtlMs: 2000,
      stallGraceSec: 10,
      fetchImpl: net.fetchImpl,
      now: () => clock.nowMs,
      logger: silent,
    });
    app = buildServer({ stitcher, store, version: '0.0.0-test', nowMs: () => clock.nowMs });
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const putDesired = (payload: unknown) => app.inject({ method: 'PUT', url: '/v1/desired', payload: payload as object });

  it('GET /v1/healthz', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('PUT /v1/desired validates, applies and persists atomically', async () => {
    const res = await putDesired(desiredDoc('rev-7'));
    expect(res.statusCode).toBe(204);
    expect(stitcher.desiredRevision).toBe('rev-7');
    const persisted = await store.load();
    expect(persisted.desired).toEqual(desiredDoc('rev-7'));
    expect(persisted.selections['ch1']?.upstreamId).toBe('p-a'); // priority-1 initial pick persisted too

    const readBack = await app.inject({ method: 'GET', url: '/v1/desired' });
    expect(readBack.statusCode).toBe(200);
    expect(readBack.json()).toEqual(desiredDoc('rev-7'));
  });

  it('PUT /v1/desired rejects schema violations and duplicates all-or-nothing', async () => {
    expect((await putDesired({ apiVersion: 2, revision: 'x', channels: [] })).statusCode).toBe(400);
    expect((await putDesired({ apiVersion: 1, channels: [] })).statusCode).toBe(400); // missing revision

    const dupSlug = desiredDoc();
    dupSlug.channels.push(structuredClone(dupSlug.channels[0]!));
    expect((await putDesired(dupSlug)).statusCode).toBe(400);

    const dupUpstream = desiredDoc();
    dupUpstream.channels[0]!.upstreams.push({ id: 'p-a', url: NODE_B, priority: 3 });
    expect((await putDesired(dupUpstream)).statusCode).toBe(400);

    // nothing was applied or persisted
    expect(stitcher.desiredRevision).toBeNull();
    expect((await store.load()).desired).toBeNull();
  });

  it('GET /v1/desired is 404 before any push', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/desired' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/status matches the SwitcherStatus contract schema', async () => {
    await putDesired(desiredDoc());
    await app.inject({ method: 'GET', url: '/hls/ch1/1080p/stream.m3u8' }); // populate lag data
    clock.nowMs += 4000;
    const res = await app.inject({ method: 'GET', url: '/v1/status' });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    expect(Value.Check(SwitcherStatus, body)).toBe(true);
    const status = body as { desiredRevision: string; uptimeSec: number; channels: SwitcherChannelStatus[] };
    expect(status.desiredRevision).toBe('rev-1');
    expect(status.uptimeSec).toBeGreaterThan(0);
    expect(status.channels).toHaveLength(1);
    expect(status.channels[0]!.activeUpstreamId).toBe('p-a');
  });

  it('POST /v1/channels/:slug/switch switches, persists, and 404s for unknown slug/upstream', async () => {
    await putDesired(desiredDoc());

    const bad = await app.inject({ method: 'POST', url: '/v1/channels/nope/switch', payload: { upstreamId: 'p-b' } });
    expect(bad.statusCode).toBe(404);
    const badUp = await app.inject({ method: 'POST', url: '/v1/channels/ch1/switch', payload: { upstreamId: 'zzz' } });
    expect(badUp.statusCode).toBe(404);
    const badBody = await app.inject({ method: 'POST', url: '/v1/channels/ch1/switch', payload: {} });
    expect(badBody.statusCode).toBe(400);

    const ok = await app.inject({ method: 'POST', url: '/v1/channels/ch1/switch', payload: { upstreamId: 'p-b' } });
    expect(ok.statusCode).toBe(200);
    const channel = ok.json() as SwitcherChannelStatus;
    expect(channel.activeUpstreamId).toBe('p-b');
    expect(channel.lastSwitch?.reason).toBe('manual');
    expect((await store.load()).selections['ch1']?.upstreamId).toBe('p-b');
  });

  it('GET /hls/:slug/playlist.m3u8 serves the rewritten master with HLS content-type, CORS and no-store', async () => {
    await putDesired(desiredDoc());
    const res = await app.inject({ method: 'GET', url: '/hls/ch1/playlist.m3u8' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.apple.mpegurl');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('/hls/ch1/1080p/stream.m3u8');
    expect(res.body).toContain('URI="/hls/ch1/arib_ass/stream.m3u8"');
  });

  it('GET /hls media playlist serves rewritten segments; unknown slug/variant are 404', async () => {
    await putDesired(desiredDoc());
    const res = await app.inject({ method: 'GET', url: '/hls/ch1/1080p/stream.m3u8' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.apple.mpegurl');
    expect(res.body).toContain(`${NODE_A}/1080p/`);

    const noSlug = await app.inject({ method: 'GET', url: '/hls/nope/playlist.m3u8' });
    expect(noSlug.statusCode).toBe(404);
    expect(noSlug.headers['access-control-allow-origin']).toBe('*');

    await app.inject({ method: 'GET', url: '/hls/ch1/playlist.m3u8' }); // learn the variant set
    const noVariant = await app.inject({ method: 'GET', url: '/hls/ch1/bogus/stream.m3u8' });
    expect(noVariant.statusCode).toBe(404);
  });

  it('GET /hls returns 503 with Retry-After when no upstream is available', async () => {
    const doc = desiredDoc('rev-solo');
    doc.channels = [
      { slug: 'solo', segmentSeconds: 5, upstreams: [{ id: 'only', url: 'http://dead-node/media/solo', priority: 1 }] },
    ];
    await putDesired(doc); // dead-node has no routes → every fetch 404s
    const res = await app.inject({ method: 'GET', url: '/hls/solo/1080p/stream.m3u8' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
