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
 * Switcher HTTP surface: the read-only /v1 health/status API (contract/v1.ts,
 * unauthenticated by contract — never expose it publicly, see
 * deploy/k8s/switcher.yaml) and the viewer-facing /hls virtual-playlist
 * routes. Desired-doc pushes and manual switches arrive over the WebSocket
 * link (controllerLink.ts, contract/ws1.ts) instead of this HTTP surface.
 */

import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { SwitcherStatus } from '../contract/v1.js';
import type { ControllerLink } from './controllerLink.js';
import {
  type Logger,
  type Stitcher,
  UnknownChannelError,
  UnknownVariantError,
  UpstreamUnavailableError,
} from './stitch.js';

export interface SwitcherServerOptions {
  stitcher: Stitcher;
  link: Pick<ControllerLink, 'connected' | 'docReceived' | 'noteDemand'>;
  version: string;
  logger?: Logger;
  nowMs?: () => number;
}

const HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

/**
 * Server-side cap on the on-demand cold-start hold (stitch.ts#waitServeable).
 * The stock player (shaka-player) gives up on its own after ~20.5s (a 10s
 * connectionTimeout attempt, one retry with a fresh 10s budget), but a
 * tuned/other client may hold longer, so the server enforces its own ceiling
 * rather than trusting the client to go away.
 */
const HOLD_CAP_MS = 30_000;

function sendHlsError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof UnknownChannelError || err instanceof UnknownVariantError) {
    return reply.code(404).send({ error: err.message });
  }
  if (err instanceof UpstreamUnavailableError) {
    return reply.code(503).header('retry-after', String(err.retryAfterSec)).send({ error: err.message });
  }
  throw err;
}

/**
 * Holds a viewer's playlist request open while an `onDemand` channel's
 * encode is still starting: waits (up to HOLD_CAP_MS) for the active
 * upstream to become serveable, aborting early if the viewer disconnects.
 * The caller retries its fetch exactly once regardless of the outcome —
 * `{ aborted: true }` means don't reply at all (the client is gone).
 */
async function holdForServeable(
  req: FastifyRequest,
  stitcher: Stitcher,
  slug: string,
): Promise<{ aborted: boolean }> {
  const controller = new AbortController();
  const onClose = (): void => controller.abort();
  req.raw.on('close', onClose);
  try {
    await stitcher.waitServeable(slug, HOLD_CAP_MS, controller.signal);
  } finally {
    req.raw.off('close', onClose);
  }
  return { aborted: controller.signal.aborted };
}

export function buildServer(opts: SwitcherServerOptions): FastifyInstance {
  const { stitcher, link } = opts;
  const nowMs = opts.nowMs ?? Date.now;
  const startedAtMs = nowMs();
  const startedAt = new Date(startedAtMs).toISOString();
  const app = fastify({ logger: false });

  // Browsers play the switcher's playlists cross-origin, and virtual
  // playlists must never be cached — a stale one desyncs the virtual
  // MEDIA-SEQUENCE. Applied to every /hls response, including errors.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/hls/')) {
      void reply.header('access-control-allow-origin', '*');
      if (!reply.getHeader('cache-control')) void reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  app.get('/v1/healthz', async () => ({ ok: true }));

  app.get('/v1/status', async (): Promise<SwitcherStatus> => ({
    apiVersion: 1,
    switcherVersion: opts.version,
    startedAt,
    uptimeSec: Math.max(0, (nowMs() - startedAtMs) / 1000),
    desiredRevision: stitcher.desiredRevision,
    channels: stitcher.channelStatuses(),
  }));

  // Readiness gates on having applied a doc, NOT on the live connection: a
  // replica holding a doc keeps serving through a controller outage or
  // restart, but a fresh pod without one must never receive traffic.
  app.get('/v1/readyz', async (_req, reply) => {
    if (link.docReceived) return { ok: true };
    return reply.code(503).send({ ok: false, connected: link.connected, docReceived: false });
  });

  app.get<{ Params: { slug: string } }>('/hls/:slug/playlist.m3u8', async (req, reply) => {
    link.noteDemand(req.params.slug, 'master');
    try {
      const text = await stitcher.getMasterPlaylist(req.params.slug);
      return reply.header('content-type', HLS_CONTENT_TYPE).send(text);
    } catch (err) {
      if (!(err instanceof UpstreamUnavailableError) || !stitcher.isOnDemand(req.params.slug)) {
        return sendHlsError(reply, err);
      }
      const { aborted } = await holdForServeable(req, stitcher, req.params.slug);
      if (aborted) {
        reply.hijack();
        return reply;
      }
      try {
        const text = await stitcher.getMasterPlaylist(req.params.slug);
        return reply.header('content-type', HLS_CONTENT_TYPE).send(text);
      } catch (err2) {
        return sendHlsError(reply, err2);
      }
    }
  });

  app.get<{ Params: { slug: string; variant: string } }>(
    '/hls/:slug/:variant/stream.m3u8',
    async (req, reply) => {
      link.noteDemand(req.params.slug, 'media');
      try {
        const text = await stitcher.getMediaPlaylist(req.params.slug, req.params.variant);
        return reply.header('content-type', HLS_CONTENT_TYPE).send(text);
      } catch (err) {
        if (!(err instanceof UpstreamUnavailableError) || !stitcher.isOnDemand(req.params.slug)) {
          return sendHlsError(reply, err);
        }
        const { aborted } = await holdForServeable(req, stitcher, req.params.slug);
        if (aborted) {
          reply.hijack();
          return reply;
        }
        try {
          const text = await stitcher.getMediaPlaylist(req.params.slug, req.params.variant);
          return reply.header('content-type', HLS_CONTENT_TYPE).send(text);
        } catch (err2) {
          return sendHlsError(reply, err2);
        }
      }
    },
  );

  return app;
}
