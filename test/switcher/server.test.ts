/*
 * Route-level tests via fastify.inject: /v1/status contract shape,
 * /v1/readyz gating on docReceived, the /hls serving routes (content-type,
 * CORS, no-store, 404/503 paths, demand notification), against a fake
 * ControllerLink — desired-doc pushes and switches arrive over the WS link
 * (controllerLink.test.ts), not this HTTP surface.
 */

import { Value } from '@sinclair/typebox/value';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SwitcherStatus, type SwitcherChannelStatus } from '../../src/contract/v1.js';
import type { ControllerLink } from '../../src/switcher/controllerLink.js';
import { buildServer } from '../../src/switcher/server.js';
import { Stitcher } from '../../src/switcher/stitch.js';
import { NODE_A, NODE_B, T0, desiredDoc, liveUpstream, makeFetch, type FakeNet } from './fixtures.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

type FakeLink = Pick<ControllerLink, 'connected' | 'docReceived' | 'noteDemand'>;

function makeLink(overrides: Partial<{ connected: boolean; docReceived: boolean }> = {}): FakeLink {
  return {
    connected: overrides.connected ?? true,
    docReceived: overrides.docReceived ?? false,
    noteDemand: vi.fn(),
  };
}

describe('switcher server', () => {
  let net: FakeNet;
  let clock: { nowMs: number };
  let stitcher: Stitcher;
  let link: FakeLink;
  let app: FastifyInstance;

  beforeEach(() => {
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
    link = makeLink();
    app = buildServer({ stitcher, link, version: '0.0.0-test', nowMs: () => clock.nowMs });
  });
  afterEach(async () => {
    await app.close();
  });

  it('GET /v1/healthz', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('GET /v1/readyz is 503 before any doc has been applied', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, connected: true, docReceived: false });
  });

  it('GET /v1/readyz is 200 once a doc has been applied', async () => {
    stitcher.applyDesired(desiredDoc());
    link.docReceived = true;
    const res = await app.inject({ method: 'GET', url: '/v1/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('GET /v1/readyz stays 200 through a controller outage (docReceived true, connected false)', async () => {
    stitcher.applyDesired(desiredDoc());
    link = makeLink({ connected: false, docReceived: true });
    app = buildServer({ stitcher, link, version: '0.0.0-test', nowMs: () => clock.nowMs });
    const res = await app.inject({ method: 'GET', url: '/v1/readyz' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /v1/status matches the SwitcherStatus contract schema', async () => {
    stitcher.applyDesired(desiredDoc());
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

  it('GET /hls/:slug/playlist.m3u8 serves the relative master with HLS content-type, CORS and no-store', async () => {
    stitcher.applyDesired(desiredDoc());
    const res = await app.inject({ method: 'GET', url: '/hls/ch1/playlist.m3u8' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.apple.mpegurl');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toBe('no-store');
    // relative to the master's own URL: works behind any reverse-proxy prefix
    expect(res.body).toContain('\n1080p/stream.m3u8');
    expect(res.body).toContain('URI="arib_ass/stream.m3u8"');
    expect(res.body).not.toContain('/hls/');
    expect(link.noteDemand).toHaveBeenCalledWith('ch1', 'master');
  });

  it('GET /hls media playlist serves absolute upstream-URL segments; unknown slug/variant are 404', async () => {
    stitcher.applyDesired(desiredDoc());
    const res = await app.inject({ method: 'GET', url: '/hls/ch1/1080p/stream.m3u8' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.apple.mpegurl');
    expect(res.body).toContain(`\n${NODE_A}/1080p/`);
    expect(link.noteDemand).toHaveBeenCalledWith('ch1', 'media');

    const noSlug = await app.inject({ method: 'GET', url: '/hls/nope/playlist.m3u8' });
    expect(noSlug.statusCode).toBe(404);
    expect(noSlug.headers['access-control-allow-origin']).toBe('*');
    expect(link.noteDemand).toHaveBeenCalledWith('nope', 'master');

    await app.inject({ method: 'GET', url: '/hls/ch1/playlist.m3u8' }); // learn the variant set
    const noVariant = await app.inject({ method: 'GET', url: '/hls/ch1/bogus/stream.m3u8' });
    expect(noVariant.statusCode).toBe(404);
    expect(link.noteDemand).toHaveBeenCalledWith('ch1', 'media');
  });

  it('GET /hls returns 503 with Retry-After when no upstream is available', async () => {
    const doc = desiredDoc('rev-solo');
    doc.channels = [
      { slug: 'solo', segmentSeconds: 5, upstreams: [{ id: 'only', url: 'http://dead-node/media/solo', priority: 1 }] },
    ];
    stitcher.applyDesired(doc); // dead-node has no routes → every fetch 404s
    const res = await app.inject({ method: 'GET', url: '/hls/solo/1080p/stream.m3u8' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(link.noteDemand).toHaveBeenCalledWith('solo', 'media');
  });
});
