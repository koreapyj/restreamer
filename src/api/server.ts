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
import type { Supervisor } from '../supervise/supervisor.js';
import type { Logger } from '../supervise/types.js';
import { VERSION } from '../version.js';

export interface ServerDeps {
  supervisor: Supervisor;
  config: DaemonConfig;
  logger?: Logger;
}

/** Fastify instance implementing the daemon side of the wire contract v1. */
export function createServer(deps: ServerDeps): FastifyInstance {
  const { supervisor, config } = deps;
  const logger = deps.logger ?? console;
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
    sessions: supervisor.statuses(),
  }));

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

  return app;
}
