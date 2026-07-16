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
 * Switcher↔controller WebSocket wire contract v1 — the switcher dials the
 * controller and keeps one persistent socket open, replacing the
 * controller-dialed HTTP control API in contract/v1.ts (the switcher's
 * viewer-facing `/hls` routes and its read-only `/v1` health/status
 * endpoints are unaffected).
 *
 * tvh-controller vendors this file verbatim as
 * `packages/shared/src/restreamer-ws-contract.ts` — keep it dependency-clean
 * (only `@sinclair/typebox` plus contract/v1.ts) and free of daemon
 * internals.
 *
 * Every message is one JSON text frame with envelope `{ v: 1, type: string,
 * ... }`. Receivers ignore unknown `type` values (forward compatibility); an
 * unknown `v` closes the socket with code `WS_CLOSE_UNSUPPORTED_VERSION`.
 */

import { type Static, Type } from '@sinclair/typebox';
import { SessionName, SwitcherChannelStatus, SwitcherDesiredState } from './v1.js';

export const WS_PROTOCOL_VERSION = 1;

/** close code sent when a peer's envelope `v` is not `WS_PROTOCOL_VERSION` */
export const WS_CLOSE_UNSUPPORTED_VERSION = 4400;

// ---------------------------------------------------------------------------
// Downstream (controller → switcher)
// ---------------------------------------------------------------------------

/** first frame after connect */
export const WsHelloDown = Type.Object({
  v: Type.Literal(1),
  type: Type.Literal('hello'),
  serverVersion: Type.String(),
});
export type WsHelloDown = Static<typeof WsHelloDown>;

/** full desired-state replace; sent on connect and on every change, latest wins */
export const WsDoc = Type.Object({
  v: Type.Literal(1),
  type: Type.Literal('doc'),
  doc: SwitcherDesiredState,
});
export type WsDoc = Static<typeof WsDoc>;

/**
 * low-latency active-upstream switch; the next doc broadcast carries the same
 * selection, so applying it is idempotent.
 */
export const WsSwitch = Type.Object({
  v: Type.Literal(1),
  type: Type.Literal('switch'),
  slug: SessionName,
  upstreamId: Type.String(),
});
export type WsSwitch = Static<typeof WsSwitch>;

export const WsDownMessage = Type.Union([WsHelloDown, WsDoc, WsSwitch]);
export type WsDownMessage = Static<typeof WsDownMessage>;

// ---------------------------------------------------------------------------
// Upstream (switcher → controller)
// ---------------------------------------------------------------------------

/** first frame after open */
export const WsHelloUp = Type.Object({
  v: Type.Literal(1),
  type: Type.Literal('hello'),
  switcherVersion: Type.String(),
  /** ISO 8601 */
  startedAt: Type.String(),
});
export type WsHelloUp = Static<typeof WsHelloUp>;

/**
 * sent every 5s and immediately after applying a doc or switch — the
 * immediate send doubles as the acknowledgement, there is no separate ack
 * message.
 */
export const WsStatus = Type.Object({
  v: Type.Literal(1),
  type: Type.Literal('status'),
  desiredRevision: Type.Union([Type.String(), Type.Null()]),
  channels: Type.Array(SwitcherChannelStatus),
});
export type WsStatus = Static<typeof WsStatus>;

/**
 * client playlist fetches observed since the last demand message; events are
 * coalesced sender-side to at most one per (slug, kind) per second, latest
 * timestamp wins.
 */
export const WsDemand = Type.Object({
  v: Type.Literal(1),
  type: Type.Literal('demand'),
  events: Type.Array(
    Type.Object({
      slug: SessionName,
      kind: Type.Union([Type.Literal('master'), Type.Literal('media')]),
      /** ISO 8601 — timestamp of the most recent client playlist fetch */
      at: Type.String(),
    }),
  ),
});
export type WsDemand = Static<typeof WsDemand>;

export const WsUpMessage = Type.Union([WsHelloUp, WsStatus, WsDemand]);
export type WsUpMessage = Static<typeof WsUpMessage>;
