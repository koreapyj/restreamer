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
 * Daemon HTTP API (wire contract v1) — thin Fastify routes over the
 * supervisor. Unauthenticated BY CONTRACT: same trust model as
 * `rclone rcd --rc-no-auth`, safe only on a LAN/VPN-isolated bind (see
 * deploy/restreamer.service for the full security note).
 *
 * Error shape is uniform JSON: `{error: string, details?: unknown}`.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { Value } from '@sinclair/typebox/value';
import { DesiredState, RESTREAMER_API_VERSION, type StatusResponse } from '../contract/v1.js';
import type { DaemonConfig } from '../config.js';
import { templates } from '../pipeline/templates/index.js';
import type { SourcesCatalog } from '../sources/catalog.js';
import type { Supervisor } from '../supervise/supervisor.js';
import type { Logger } from '../supervise/types.js';
import { createDaemonLog, type DaemonLog } from '../util/daemonLog.js';
import { VERSION } from '../version.js';

export interface ServerDeps {
  supervisor: Supervisor;
  config: DaemonConfig;
  /** local external-sources catalog (GET /v1/sources, status sourcesHash) */
  catalog: SourcesCatalog;
  logger?: Logger;
  /** daemon-level log ring (GET /v1/log, /v1/log/stream); default wraps `logger` in a fresh ring */
  daemonLog?: DaemonLog;
}

/** Fastify instance implementing the daemon side of the wire contract v1. */
export function createServer(deps: ServerDeps): FastifyInstance {
  const { supervisor, config, catalog } = deps;
  const logger = deps.logger ?? console;
  const daemonLog = deps.daemonLog ?? createDaemonLog(logger, config.logLines);
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();

  const app = Fastify({ logger: false });

  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).send({ error: 'not found' });
  });

  // uniform {error} shape for body-parse failures and anything a handler throws
  app.setErrorHandler((err: unknown, _req, reply) => {
    const message = err instanceof Error ? err.message : String(err);
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    const status = typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    if (status >= 500) logger.error(`[api] internal error: ${message}`);
    void reply.status(status).send({ error: message });
  });

  app.get('/v1/healthz', async () => ({ ok: true }));

  app.get('/v1/status', async (): Promise<StatusResponse> => ({
    apiVersion: RESTREAMER_API_VERSION,
    daemonVersion: VERSION,
    startedAt: startedAtIso,
    uptimeSec: (Date.now() - startedAtMs) / 1000,
    capabilities: config.capabilities,
    templates: Object.values(templates).flatMap((t) => (t ? [{ id: t.id, version: t.version }] : [])),
    desiredRevision: supervisor.desiredRevision,
    sourcesHash: catalog.hash,
    sessions: supervisor.statuses(),
    pendingRemovals: supervisor.pendingRemovals(),
    // undefined until a doc has ever been applied — JSON serialization drops it
    lastAppliedAt: supervisor.lastAppliedAt,
    persistedStateCorrupt: supervisor.persistedStateCorrupt,
  }));

  app.get('/v1/sources', async () => catalog.snapshot());

  app.get('/v1/desired', async (_req, reply) => {
    const doc = supervisor.getDesired();
    if (doc === null) {
      return reply.status(404).send({ error: 'no desired state has been pushed or persisted yet' });
    }
    return doc;
  });

  app.put('/v1/desired', async (req, reply) => {
    const body: unknown = req.body;
    const apiVersion =
      typeof body === 'object' && body !== null ? (body as { apiVersion?: unknown }).apiVersion : undefined;
    if (apiVersion !== RESTREAMER_API_VERSION) {
      return reply.status(400).send({
        error: `unsupported apiVersion ${JSON.stringify(apiVersion)} — this daemon only speaks apiVersion ${RESTREAMER_API_VERSION}`,
      });
    }
    if (!Value.Check(DesiredState, body)) {
      const details = [...Value.Errors(DesiredState, body)]
        .slice(0, 20)
        .map((e) => `${e.path || '/'}: ${e.message}`);
      return reply.status(400).send({ error: 'desired state failed schema validation', details });
    }
    try {
      // validates every session (schema + dry-run argv build) — all-or-nothing
      await supervisor.applyDesired(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[api] PUT /v1/desired rejected: ${msg}`);
      return reply.status(400).send({ error: 'desired state rejected', details: msg });
    }
    return { accepted: true, revision: body.revision };
  });

  app.post('/v1/sessions/:name/restart', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      await supervisor.restartSession(name);
    } catch {
      // restartSession only throws for names it does not supervise
      return reply.status(404).send({ error: `unknown session: ${name}` });
    }
    return { ok: true };
  });

  app.get('/v1/sessions/:name/log', async (req, reply) => {
    const { name } = req.params as { name: string };
    const raw = (req.query as { lines?: string }).lines;
    let lines = config.logLines;
    if (raw !== undefined) {
      lines = Number(raw);
      if (!Number.isInteger(lines) || lines < 0) {
        return reply.status(400).send({ error: `invalid lines parameter: ${raw}` });
      }
    }
    const tail = supervisor.sessionLog(name, lines);
    if (tail === null) return reply.status(404).send({ error: `unknown session: ${name}` });
    return { name, lines: tail };
  });

  app.post('/v1/sessions/:name/restarts/reset', async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!supervisor.resetSessionRestarts(name)) {
      return reply.status(404).send({ error: `unknown session: ${name}` });
    }
    return { ok: true };
  });

  /**
   * Server-Sent Events: replays the ring tail as `event: log` frames (payload
   * = LogLine), then streams live lines; `event: end` when the Session object
   * is discarded (config change / removal) — clients reconnect to pick up any
   * replacement session under the same name. An `invalid` session (no live
   * Session) gets an empty replay + immediate end, mirroring GET .../log.
   */
  app.get('/v1/sessions/:name/log/stream', (req, reply) => {
    const { name } = req.params as { name: string };
    const raw = (req.query as { lines?: string }).lines;
    let tailLines = config.logLines;
    if (raw !== undefined) {
      tailLines = Number(raw);
      if (!Number.isInteger(tailLines) || tailLines < 0) {
        return reply.status(400).send({ error: `invalid lines parameter: ${raw}` });
      }
    }
    // existence check BEFORE hijacking — the only chance to send a 404
    if (supervisor.sessionLog(name, 0) === null) {
      return reply.status(404).send({ error: `unknown session: ${name}` });
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // nginx: never buffer SSE
    });
    res.write('retry: 3000\n\n');

    const MAX_BUFFERED_BYTES = 256 * 1024;
    let closed = false;
    let keepalive: unknown;
    let unsubscribe: (() => void) | undefined;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (keepalive !== undefined) clearInterval(keepalive as NodeJS.Timeout);
      unsubscribe?.();
      try {
        res.end();
      } catch {
        /* connection already gone */
      }
    };
    const send = (event: string, data: unknown): void => {
      if (closed) return;
      // slow client: drop the connection instead of buffering unboundedly
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        cleanup();
        return;
      }
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        cleanup();
      }
    };

    // no await between the 404 check above and this call — the event loop
    // cannot run a reconcile in between, so this cannot race a removal
    const subscription = supervisor.subscribeSessionLog(name, tailLines, {
      onLine: (entry) => send('log', entry),
      onEnd: () => {
        send('end', {});
        cleanup();
      },
    });
    if (!subscription) {
      // unreachable (checked above), but never leave the response hanging
      cleanup();
      return;
    }
    for (const entry of subscription.tail) send('log', entry);
    if (!subscription.live) {
      send('end', {});
      cleanup();
      return;
    }
    unsubscribe = subscription.unsubscribe;
    keepalive = setInterval(() => {
      if (closed) return;
      try {
        res.write(': keepalive\n\n');
      } catch {
        cleanup();
      }
    }, 25_000);
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });

  app.get('/v1/log', async (req, reply) => {
    const raw = (req.query as { lines?: string }).lines;
    let lines = config.logLines;
    if (raw !== undefined) {
      lines = Number(raw);
      if (!Number.isInteger(lines) || lines < 0) {
        return reply.status(400).send({ error: `invalid lines parameter: ${raw}` });
      }
    }
    return { lines: daemonLog.logTail(lines) };
  });

  /**
   * Server-Sent Events: the daemon logger's ring tail as `event: log` frames
   * (payload = LogLine with src 'daemon'), then live lines; `event: end` on
   * shutdown (endLogStreams before server close). Same framing, slow-client
   * cutoff and keepalive as the per-session stream.
   */
  app.get('/v1/log/stream', (req, reply) => {
    const raw = (req.query as { lines?: string }).lines;
    let tailLines = config.logLines;
    if (raw !== undefined) {
      tailLines = Number(raw);
      if (!Number.isInteger(tailLines) || tailLines < 0) {
        return reply.status(400).send({ error: `invalid lines parameter: ${raw}` });
      }
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // nginx: never buffer SSE
    });
    res.write('retry: 3000\n\n');

    const MAX_BUFFERED_BYTES = 256 * 1024;
    let closed = false;
    let keepalive: unknown;
    let unsubscribe: (() => void) | undefined;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (keepalive !== undefined) clearInterval(keepalive as NodeJS.Timeout);
      unsubscribe?.();
      try {
        res.end();
      } catch {
        /* connection already gone */
      }
    };
    const send = (event: string, data: unknown): void => {
      if (closed) return;
      // slow client: drop the connection instead of buffering unboundedly
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        cleanup();
        return;
      }
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        cleanup();
      }
    };

    // tail + listener registration is atomic inside subscribeLog — no line is
    // duplicated or dropped across the replay/live boundary
    const subscription = daemonLog.subscribeLog(tailLines, {
      onLine: (entry) => send('log', entry),
      onEnd: () => {
        send('end', {});
        cleanup();
      },
    });
    for (const entry of subscription.tail) send('log', entry);
    unsubscribe = subscription.unsubscribe;
    keepalive = setInterval(() => {
      if (closed) return;
      try {
        res.write(': keepalive\n\n');
      } catch {
        cleanup();
      }
    }, 25_000);
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });

  return app;
}
