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
 * Switcher HTTP surface: the /v1 control API (contract/v1.ts, unauthenticated
 * by contract — never expose it publicly, see deploy/k8s/switcher.yaml) and
 * the viewer-facing /hls virtual-playlist routes.
 */

import fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  SwitchCommand,
  SwitcherDesiredState,
  type SwitcherStatus,
} from '../contract/v1.js';
import type { SwitcherStore } from './desiredStore.js';
import {
  type Logger,
  type Stitcher,
  UnknownChannelError,
  UnknownUpstreamError,
  UnknownVariantError,
  UpstreamUnavailableError,
} from './stitch.js';

export interface SwitcherServerOptions {
  stitcher: Stitcher;
  store: SwitcherStore;
  version: string;
  logger?: Logger;
  nowMs?: () => number;
}

const HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

function schemaErrors(schema: TSchema, value: unknown): string {
  return [...Value.Errors(schema, value)]
    .slice(0, 10)
    .map((e) => `${e.path || '/'}: ${e.message}`)
    .join('; ');
}

function sendHlsError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof UnknownChannelError || err instanceof UnknownVariantError) {
    return reply.code(404).send({ error: err.message });
  }
  if (err instanceof UpstreamUnavailableError) {
    return reply.code(503).header('retry-after', String(err.retryAfterSec)).send({ error: err.message });
  }
  throw err;
}

export function buildServer(opts: SwitcherServerOptions): FastifyInstance {
  const { stitcher, store } = opts;
  const nowMs = opts.nowMs ?? Date.now;
  const startedAtMs = nowMs();
  const startedAt = new Date(startedAtMs).toISOString();
  const app = fastify({ logger: false });

  const persist = async (): Promise<void> => {
    await store.save(stitcher.getDesired(), stitcher.getSelections());
  };

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

  app.get('/v1/desired', async (_req, reply) => {
    const doc = stitcher.getDesired();
    if (!doc) return reply.code(404).send({ error: 'no desired state has been pushed yet' });
    return doc;
  });

  // Full replacement, all-or-nothing: the whole doc must pass the schema plus
  // uniqueness checks before anything is applied or persisted.
  app.put('/v1/desired', async (req, reply) => {
    const body: unknown = req.body;
    if (!Value.Check(SwitcherDesiredState, body)) {
      return reply.code(400).send({ error: `invalid desired state: ${schemaErrors(SwitcherDesiredState, body)}` });
    }
    const slugs = new Set<string>();
    for (const channel of body.channels) {
      if (slugs.has(channel.slug)) {
        return reply.code(400).send({ error: `invalid desired state: duplicate channel slug ${channel.slug}` });
      }
      slugs.add(channel.slug);
      const ids = new Set<string>();
      for (const up of channel.upstreams) {
        if (ids.has(up.id)) {
          return reply
            .code(400)
            .send({ error: `invalid desired state: duplicate upstream id ${up.id} in channel ${channel.slug}` });
        }
        ids.add(up.id);
      }
    }
    stitcher.applyDesired(body);
    await persist();
    return reply.code(204).send();
  });

  app.post<{ Params: { slug: string } }>('/v1/channels/:slug/switch', async (req, reply) => {
    const body: unknown = req.body;
    if (!Value.Check(SwitchCommand, body)) {
      return reply.code(400).send({ error: `invalid switch command: ${schemaErrors(SwitchCommand, body)}` });
    }
    try {
      stitcher.switchTo(req.params.slug, body.upstreamId, 'manual');
    } catch (err) {
      if (err instanceof UnknownChannelError || err instanceof UnknownUpstreamError) {
        return reply.code(404).send({ error: err.message });
      }
      throw err;
    }
    await persist();
    return stitcher.channelStatuses().find((c) => c.slug === req.params.slug);
  });

  app.get<{ Params: { slug: string } }>('/hls/:slug/playlist.m3u8', async (req, reply) => {
    try {
      const text = await stitcher.getMasterPlaylist(req.params.slug);
      return reply.header('content-type', HLS_CONTENT_TYPE).send(text);
    } catch (err) {
      return sendHlsError(reply, err);
    }
  });

  app.get<{ Params: { slug: string; variant: string } }>(
    '/hls/:slug/:variant/stream.m3u8',
    async (req, reply) => {
      try {
        const text = await stitcher.getMediaPlaylist(req.params.slug, req.params.variant);
        return reply.header('content-type', HLS_CONTENT_TYPE).send(text);
      } catch (err) {
        return sendHlsError(reply, err);
      }
    },
  );

  return app;
}
