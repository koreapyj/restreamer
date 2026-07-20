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
 * ControllerLink: the switcher's WebSocket CLIENT (see contract/ws1.ts). The
 * switcher dials the controller and keeps one persistent socket open,
 * reconnecting with backoff whenever it drops — desired-doc pushes and
 * manual switches arrive as frames on it, and it carries status/demand back.
 *
 * There is no local persistence: a replica serves from whatever doc it last
 * received in memory, and readiness (`/v1/readyz` in server.ts) gates on
 * `docReceived` rather than on the live connection, so a replica keeps
 * serving through a controller outage. Multiple replicas each hold their own
 * independent copy of the same doc — see deploy/k8s/switcher.yaml.
 */

import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { RawData } from 'ws';
import { WebSocket } from 'ws';
import { SwitcherDesiredState } from '../contract/v1.js';
import {
  WS_CLOSE_UNSUPPORTED_VERSION,
  WS_PROTOCOL_VERSION,
  WsHelloDown,
  WsSwitch,
  type WsDemand,
  type WsHelloUp,
  type WsStatus,
  type WsUpMessage,
} from '../contract/ws1.js';
import { type Logger, type Stitcher, UnknownChannelError, UnknownUpstreamError } from './stitch.js';

const DEFAULT_STATUS_INTERVAL_MS = 5000;
const DEFAULT_DEMAND_COALESCE_MS = 1000;
const DEFAULT_RECONNECT_MIN_MS = 1000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

/** how often the link pings the controller and checks for silence */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** no message/pong for this long while connected ⇒ the socket is presumed dead */
const HEARTBEAT_TIMEOUT_MS = 60_000;

const NULL_LOGGER: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function schemaErrors(schema: TSchema, value: unknown): string {
  return [...Value.Errors(schema, value)]
    .slice(0, 10)
    .map((e) => `${e.path || '/'}: ${e.message}`)
    .join('; ');
}

/**
 * Validates a candidate desired doc: schema plus the uniqueness invariants
 * (duplicate channel slugs / duplicate upstream ids within a channel) that
 * the schema alone can't express. Pure and side-effect free — shared by
 * ControllerLink's 'doc' frame handling and anything else that needs to
 * check a doc before applying it.
 */
export function validateDesired(
  body: unknown,
): { ok: true; doc: SwitcherDesiredState } | { ok: false; error: string } {
  if (!Value.Check(SwitcherDesiredState, body)) {
    return { ok: false, error: `invalid desired state: ${schemaErrors(SwitcherDesiredState, body)}` };
  }
  const slugs = new Set<string>();
  for (const channel of body.channels) {
    if (slugs.has(channel.slug)) {
      return { ok: false, error: `invalid desired state: duplicate channel slug ${channel.slug}` };
    }
    slugs.add(channel.slug);
    const ids = new Set<string>();
    for (const up of channel.upstreams) {
      if (ids.has(up.id)) {
        return {
          ok: false,
          error: `invalid desired state: duplicate upstream id ${up.id} in channel ${channel.slug}`,
        };
      }
      ids.add(up.id);
    }
  }
  return { ok: true, doc: body };
}

export interface ControllerLinkOptions {
  /** the controller's WS endpoint, e.g. ws://controller:8080/ws/switcher */
  url: string;
  stitcher: Stitcher;
  /** switcher build version, reported in WsHelloUp and status */
  version: string;
  logger?: Logger;
  /** injectable clock (ms since epoch) */
  nowMs?: () => number;
  statusIntervalMs?: number;
  demandCoalesceMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** test seam — defaults to `(url) => new WebSocket(url)` */
  wsFactory?: (url: string) => WebSocket;
}

export class ControllerLink {
  private readonly url: string;
  private readonly stitcher: Stitcher;
  private readonly version: string;
  private readonly logger: Logger;
  private readonly nowMs: () => number;
  private readonly statusIntervalMs: number;
  private readonly demandCoalesceMs: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly wsFactory: (url: string) => WebSocket;
  private readonly startedAtIso: string;

  private ws: WebSocket | null = null;
  private started = false;
  private stopped = false;
  private isConnected = false;
  private hasDoc = false;

  private statusTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private demandTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private reconnectDelayMs: number;
  private lastActivityMs = 0;
  private readonly demandBuffer = new Map<string, { slug: string; kind: 'master' | 'media'; at: string }>();

  constructor(opts: ControllerLinkOptions) {
    this.url = opts.url;
    this.stitcher = opts.stitcher;
    this.version = opts.version;
    this.logger = opts.logger ?? NULL_LOGGER;
    this.nowMs = opts.nowMs ?? Date.now;
    this.statusIntervalMs = opts.statusIntervalMs ?? DEFAULT_STATUS_INTERVAL_MS;
    this.demandCoalesceMs = opts.demandCoalesceMs ?? DEFAULT_DEMAND_COALESCE_MS;
    this.reconnectMinMs = opts.reconnectMinMs ?? DEFAULT_RECONNECT_MIN_MS;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url));
    this.reconnectDelayMs = this.reconnectMinMs;
    this.startedAtIso = new Date(this.nowMs()).toISOString();
  }

  get connected(): boolean {
    return this.isConnected;
  }

  /** true once any doc has ever been applied — never resets, including across reconnects */
  get docReceived(): boolean {
    return this.hasDoc;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.demandTimer) {
      clearTimeout(this.demandTimer);
      this.demandTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    this.isConnected = false;
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
        ws.close();
      });
    }
  }

  /**
   * Records a client playlist fetch for coalesced WsDemand reporting.
   * Buffers the latest timestamp per (slug, kind) and flushes one frame per
   * demandCoalesceMs window. A no-op while disconnected — demand fetches
   * recur every segment interval, so a dropped event is reported again soon.
   */
  noteDemand(slug: string, kind: 'master' | 'media'): void {
    if (!this.isConnected) return;
    this.demandBuffer.set(`${slug}:${kind}`, { slug, kind, at: new Date(this.nowMs()).toISOString() });
    if (!this.demandTimer) {
      this.demandTimer = setTimeout(() => this.flushDemand(), this.demandCoalesceMs);
      this.demandTimer.unref?.();
    }
  }

  private connect(): void {
    if (this.stopped) return;
    let socket: WebSocket;
    try {
      socket = this.wsFactory(this.url);
    } catch (err) {
      this.logger.error(`controller link: failed to open socket: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    this.lastActivityMs = this.nowMs();

    socket.on('open', () => {
      if (this.ws !== socket) return;
      this.isConnected = true;
      this.lastActivityMs = this.nowMs();
      this.logger.info(`controller link: connected to ${this.url}`);
      this.send(socket, {
        v: WS_PROTOCOL_VERSION,
        type: 'hello',
        switcherVersion: this.version,
        startedAt: this.startedAtIso,
      } satisfies WsHelloUp);
      this.startStatusTimer();
      this.startHeartbeat(socket);
    });

    socket.on('message', (data: RawData) => {
      if (this.ws !== socket) return;
      this.lastActivityMs = this.nowMs();
      this.handleMessage(socket, data);
    });

    socket.on('pong', () => {
      if (this.ws !== socket) return;
      this.lastActivityMs = this.nowMs();
    });

    socket.on('close', () => {
      this.handleDisconnect(socket);
    });

    socket.on('error', (err: Error) => {
      this.logger.warn(`controller link: socket error: ${err.message}`);
      // 'close' still follows 'error' for ws sockets; reconnection is handled there
    });
  }

  private handleDisconnect(socket: WebSocket): void {
    if (this.ws !== socket) return; // stale socket, already superseded
    this.ws = null;
    this.isConnected = false;
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.stopped) return;
    this.logger.warn(`controller link: disconnected from ${this.url}, reconnecting`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const jitter = 1 + (Math.random() * 0.4 - 0.2); // +/-20%
    const delay = Math.min(this.reconnectMaxMs, this.reconnectDelayMs) * jitter;
    this.reconnectDelayMs = Math.min(this.reconnectMaxMs, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private handleMessage(socket: WebSocket, data: RawData): void {
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this.logger.warn('controller link: received non-JSON frame, ignoring');
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const envelope = msg as { v?: unknown; type?: unknown };
    if (envelope.v !== WS_PROTOCOL_VERSION) {
      this.logger.warn(`controller link: unsupported protocol version ${String(envelope.v)}, reconnecting`);
      socket.close(WS_CLOSE_UNSUPPORTED_VERSION);
      return;
    }

    switch (envelope.type) {
      case 'hello': {
        if (!Value.Check(WsHelloDown, msg)) {
          this.logger.warn('controller link: malformed hello frame, ignoring');
          break;
        }
        this.logger.info(`controller link: hello from controller (serverVersion ${msg.serverVersion})`);
        break;
      }
      case 'doc': {
        const result = validateDesired((msg as { doc?: unknown }).doc);
        if (!result.ok) {
          this.logger.error(`controller link: rejected desired doc: ${result.error}`);
          break;
        }
        this.stitcher.applyDesired(result.doc);
        this.hasDoc = true;
        this.reconnectDelayMs = this.reconnectMinMs; // a successful apply proves the link is healthy
        this.sendStatus(socket);
        break;
      }
      case 'switch': {
        if (!Value.Check(WsSwitch, msg)) {
          this.logger.warn('controller link: malformed switch frame, ignoring');
          break;
        }
        try {
          this.stitcher.switchTo(msg.slug, msg.upstreamId, msg.reason ?? 'manual', msg.era);
        } catch (err) {
          if (err instanceof UnknownChannelError || err instanceof UnknownUpstreamError) {
            this.logger.warn(`controller link: ${err.message}`);
          } else {
            throw err;
          }
        }
        this.sendStatus(socket);
        break;
      }
      default:
        // unknown type: forward compatibility, ignore silently
        break;
    }
  }

  private startStatusTimer(): void {
    this.statusTimer = setInterval(() => {
      if (this.ws) this.sendStatus(this.ws);
    }, this.statusIntervalMs);
    this.statusTimer.unref?.();
  }

  private startHeartbeat(socket: WebSocket): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== socket) return;
      if (this.nowMs() - this.lastActivityMs > HEARTBEAT_TIMEOUT_MS) {
        this.logger.warn('controller link: heartbeat timeout, terminating socket');
        socket.terminate();
        return; // the 'close' handler schedules the reconnect
      }
      socket.ping();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private sendStatus(socket: WebSocket): void {
    this.send(socket, {
      v: WS_PROTOCOL_VERSION,
      type: 'status',
      desiredRevision: this.stitcher.desiredRevision,
      channels: this.stitcher.channelStatuses(),
    } satisfies WsStatus);
  }

  private flushDemand(): void {
    this.demandTimer = null;
    if (this.demandBuffer.size === 0) return;
    const events = [...this.demandBuffer.values()];
    this.demandBuffer.clear();
    if (!this.ws || !this.isConnected) return; // disconnected since buffering — demand recurs, drop silently
    this.send(this.ws, { v: WS_PROTOCOL_VERSION, type: 'demand', events } satisfies WsDemand);
  }

  private send(socket: WebSocket, msg: WsUpMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(msg));
  }
}
