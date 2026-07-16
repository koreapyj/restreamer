/*
 * ControllerLink: WS client lifecycle against a real in-process
 * WebSocketServer — connect/hello, doc/switch application, demand
 * coalescing, reconnect-with-backoff, and protocol-version rejection.
 */

import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WS_CLOSE_UNSUPPORTED_VERSION } from '../../src/contract/ws1.js';
import { ControllerLink, validateDesired } from '../../src/switcher/controllerLink.js';
import { Stitcher } from '../../src/switcher/stitch.js';
import { NODE_A, NODE_B, T0, desiredDoc, liveUpstream, makeFetch } from './fixtures.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function once<T = unknown>(emitter: { once: (event: string, cb: (arg: T) => void) => void }, event: string): Promise<T> {
  return new Promise((resolve) => emitter.once(event, resolve));
}

async function startServer(): Promise<{ wss: WebSocketServer; url: string }> {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const addr = wss.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { wss, url: `ws://127.0.0.1:${port}` };
}

function nextConnection(wss: WebSocketServer): Promise<WsWebSocket> {
  return once<WsWebSocket>(wss, 'connection');
}

function nextMessage(ws: WsWebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data: Buffer) => resolve(JSON.parse(data.toString())));
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ControllerLink', () => {
  let wss: WebSocketServer;
  let url: string;
  let clock: { nowMs: number };
  let stitcher: Stitcher;
  let link: ControllerLink | undefined;

  beforeEach(async () => {
    ({ wss, url } = await startServer());
    clock = { nowMs: T0 + 1000 };
    const net = makeFetch();
    liveUpstream(net, NODE_A, clock);
    liveUpstream(net, NODE_B, clock);
    stitcher = new Stitcher({
      cacheTtlMs: 2000,
      stallGraceSec: 10,
      fetchImpl: net.fetchImpl,
      now: () => clock.nowMs,
      logger: silent,
    });
  });

  afterEach(async () => {
    await link?.stop();
    link = undefined;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  function makeLink(overrides: Partial<ConstructorParameters<typeof ControllerLink>[0]> = {}): ControllerLink {
    link = new ControllerLink({
      url,
      stitcher,
      version: '0.0.0-test',
      logger: silent,
      statusIntervalMs: 60_000,
      demandCoalesceMs: 20,
      reconnectMinMs: 20,
      reconnectMaxMs: 100,
      ...overrides,
    });
    return link;
  }

  it('connects and sends a hello frame with the switcher version', async () => {
    const l = makeLink();
    const connPromise = nextConnection(wss);
    l.start();
    const server = await connPromise;
    const hello = await nextMessage(server);
    expect(hello).toMatchObject({ v: 1, type: 'hello', switcherVersion: '0.0.0-test' });
    expect(typeof hello.startedAt).toBe('string');
    expect(l.connected).toBe(true);
  });

  it('applies a pushed doc and answers with an immediate status frame', async () => {
    const l = makeLink();
    const connPromise = nextConnection(wss);
    l.start();
    const server = await connPromise;
    await nextMessage(server); // hello
    const statusPromise = nextMessage(server);
    server.send(JSON.stringify({ v: 1, type: 'doc', doc: desiredDoc('rev-9') }));
    const status = await statusPromise;
    expect(status).toMatchObject({ v: 1, type: 'status', desiredRevision: 'rev-9' });
    expect(stitcher.desiredRevision).toBe('rev-9');
    expect(l.docReceived).toBe(true);
  });

  it('applies a switch frame and answers with an immediate status frame', async () => {
    const l = makeLink();
    const connPromise = nextConnection(wss);
    l.start();
    const server = await connPromise;
    await nextMessage(server); // hello
    server.send(JSON.stringify({ v: 1, type: 'doc', doc: desiredDoc('rev-1') }));
    await nextMessage(server); // status after doc
    const statusPromise = nextMessage(server);
    server.send(JSON.stringify({ v: 1, type: 'switch', slug: 'ch1', upstreamId: 'p-b' }));
    const status = await statusPromise;
    expect(status.channels.find((c: { slug: string }) => c.slug === 'ch1').activeUpstreamId).toBe('p-b');
  });

  it('coalesces demand events within the window into one frame', async () => {
    const l = makeLink({ demandCoalesceMs: 30 });
    const connPromise = nextConnection(wss);
    l.start();
    const server = await connPromise;
    await nextMessage(server); // hello

    const demandPromise = nextMessage(server);
    l.noteDemand('ch1', 'master');
    await wait(5);
    l.noteDemand('ch1', 'master'); // second call within the window, latest timestamp wins
    l.noteDemand('ch1', 'media');
    const demand = await demandPromise;
    expect(demand.type).toBe('demand');
    expect(demand.events).toHaveLength(2);
    const kinds = demand.events.map((e: { kind: string }) => e.kind).sort();
    expect(kinds).toEqual(['master', 'media']);
  });

  it('reconnects after the server closes the socket and re-receives a doc', async () => {
    const l = makeLink({ reconnectMinMs: 15, reconnectMaxMs: 30 });
    let connPromise = nextConnection(wss);
    l.start();
    let server = await connPromise;
    await nextMessage(server); // hello

    connPromise = nextConnection(wss);
    server.close();
    server = await connPromise;
    const hello2 = await nextMessage(server);
    expect(hello2.type).toBe('hello');

    const statusPromise = nextMessage(server);
    server.send(JSON.stringify({ v: 1, type: 'doc', doc: desiredDoc('rev-42') }));
    await statusPromise;
    expect(stitcher.desiredRevision).toBe('rev-42');
  });

  it('rejects an invalid doc (duplicate slug) without applying it or crashing', async () => {
    const l = makeLink();
    const connPromise = nextConnection(wss);
    l.start();
    const server = await connPromise;
    await nextMessage(server); // hello
    const dup = desiredDoc('rev-bad');
    dup.channels.push(structuredClone(dup.channels[0]!));
    server.send(JSON.stringify({ v: 1, type: 'doc', doc: dup }));
    await wait(30);
    expect(stitcher.desiredRevision).toBeNull();
    expect(l.docReceived).toBe(false);
  });

  it('ignores unknown message types without crashing', async () => {
    const l = makeLink();
    const connPromise = nextConnection(wss);
    l.start();
    const server = await connPromise;
    await nextMessage(server); // hello
    server.send(JSON.stringify({ v: 1, type: 'mystery-future-message' }));
    await wait(30);
    expect(l.connected).toBe(true); // socket still alive
  });

  it('tracks connected/docReceived across the lifecycle', async () => {
    const l = makeLink();
    expect(l.connected).toBe(false);
    expect(l.docReceived).toBe(false);
    const connPromise = nextConnection(wss);
    l.start();
    const server = await connPromise;
    await nextMessage(server); // hello
    expect(l.connected).toBe(true);
    expect(l.docReceived).toBe(false);
    server.send(JSON.stringify({ v: 1, type: 'doc', doc: desiredDoc() }));
    await wait(30);
    expect(l.docReceived).toBe(true);
    await l.stop();
    expect(l.connected).toBe(false);
    expect(l.docReceived).toBe(true); // never resets
  });

  it('closes with WS_CLOSE_UNSUPPORTED_VERSION and reconnects on an unsupported protocol version', async () => {
    const l = makeLink({ reconnectMinMs: 15, reconnectMaxMs: 30 });
    let connPromise = nextConnection(wss);
    l.start();
    let server = await connPromise;
    await nextMessage(server); // hello

    const closePromise = once<number>(server, 'close');
    connPromise = nextConnection(wss);
    server.send(JSON.stringify({ v: 2, type: 'doc', doc: desiredDoc() }));
    const code = await closePromise;
    expect(code).toBe(WS_CLOSE_UNSUPPORTED_VERSION);
    const server2 = await connPromise; // reconnected
    const hello2 = await nextMessage(server2);
    expect(hello2.type).toBe('hello');
  });
});

describe('validateDesired', () => {
  it('accepts a well-formed doc', () => {
    const result = validateDesired(desiredDoc());
    expect(result.ok).toBe(true);
  });

  it('rejects schema violations', () => {
    const result = validateDesired({ apiVersion: 2, revision: 'x', channels: [] });
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate channel slugs', () => {
    const doc = desiredDoc();
    doc.channels.push(structuredClone(doc.channels[0]!));
    const result = validateDesired(doc);
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate upstream ids within a channel', () => {
    const doc = desiredDoc();
    doc.channels[0]!.upstreams.push({ id: 'p-a', url: NODE_B, priority: 3 });
    const result = validateDesired(doc);
    expect(result.ok).toBe(false);
  });
});
