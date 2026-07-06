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
 * Wire contract v1 — the canonical source of truth for the daemon AND the
 * switcher HTTP APIs.
 *
 * tvh-controller vendors this file verbatim as
 * `packages/shared/src/restreamer-contract.ts` — keep it dependency-clean
 * (only `@sinclair/typebox`) and free of daemon internals.
 *
 * Versioning: every document/status carries `apiVersion: 1`; the daemon and
 * the switcher reject unknown versions. Additive changes stay in v1 (new
 * fields must be optional); breaking changes become `/v2`.
 *
 * All `default` annotations reproduce current production values.
 */

import { type Static, Type } from '@sinclair/typebox';

export const RESTREAMER_API_VERSION = 1;

// ---------------------------------------------------------------------------
// Session naming
// ---------------------------------------------------------------------------

/**
 * Session name — also the output directory under `serveDir` and the public
 * URL path segment (`<serveUrl>/<name>/playlist.m3u8`).
 */
export const SESSION_NAME_PATTERN = '^[a-z0-9][a-z0-9-]{0,63}$';

const SessionName = Type.String({ pattern: SESSION_NAME_PATTERN });

// ---------------------------------------------------------------------------
// Desired state (controller → daemon, PUT /v1/desired)
// ---------------------------------------------------------------------------

/** tvheadend source — daemon streams `/stream/channel/<channelUuid>`. */
export const TvhSource = Type.Object({
  channelUuid: Type.String({ minLength: 1 }),
  /** tvheadend stream profile */
  streamProfile: Type.Optional(Type.String({ default: 'pass' })),
  /** tvheadend subscription weight (preemption priority; DVR wins) */
  weight: Type.Optional(Type.Number()),
});
export type TvhSource = Static<typeof TvhSource>;

/** escape hatch for a non-tvheadend source */
export const UrlSource = Type.Object({
  url: Type.String({ minLength: 1 }),
});
export type UrlSource = Static<typeof UrlSource>;

export const SessionSource = Type.Union([TvhSource, UrlSource]);
export type SessionSource = Static<typeof SessionSource>;

/**
 * tsreadex parameters. The mode defaults reproduce the production invocation
 * `tsreadex -a 13 -b 7 -c 5 -u 2 -n <sid>`.
 */
export const TsreadexParams = Type.Object({
  /**
   * service SID (program number) → `tsreadex -n`; normally derived
   * channel→service→sid by the controller. Absent = the daemon PAT-probes the
   * source and picks the single (or lowest, logged) program_number.
   */
  programNumber: Type.Optional(Type.Integer({ minimum: 0 })),
  /** ARIB primary-audio mode → `tsreadex -a` */
  audio1Mode: Type.Optional(Type.Integer({ default: 13 })),
  /** ARIB secondary-audio mode → `tsreadex -b` */
  audio2Mode: Type.Optional(Type.Integer({ default: 7 })),
  /** ARIB caption mode → `tsreadex -c` */
  captionMode: Type.Optional(Type.Integer({ default: 5 })),
  /** ARIB superimpose mode → `tsreadex -u` */
  superimposeMode: Type.Optional(Type.Integer({ default: 2 })),
});
export type TsreadexParams = Static<typeof TsreadexParams>;

// ---------------------------------------------------------------------------
// Pipeline parameters — discriminated union on `template`
//
// The daemon owns each template's filter-graph skeleton, stream mapping,
// var_stream_map and HLS muxer wiring; the params below are the constrained
// knobs a profile may fill. Encoder constants (profile/tier/scenario/hvc1
// tag/cgop/aspect, libfdk_aac, hls_flags set) are template-fixed, not knobs.
// ---------------------------------------------------------------------------

/** One audio output. Bitrate default is index-dependent ('128k' for the first entry, '64k' for the rest) and therefore applied by the template, not the schema. */
export const AribHlsAudio = Type.Object({
  bitrate: Type.Optional(Type.String()),
  /** volume gain filter */
  volume: Type.Optional(Type.String({ default: '5dB' })),
  /** rendition LANGUAGE attribute */
  language: Type.Optional(Type.String()),
  /** rendition NAME attribute */
  name: Type.Optional(Type.String()),
  isDefault: Type.Optional(Type.Boolean()),
});
export type AribHlsAudio = Static<typeof AribHlsAudio>;

/**
 * 'arib-hls' — the production pipeline: MPEG-TS in, QSV HEVC + libfdk_aac +
 * ARIB→ASS subtitles + thumbnail out, browser-playable HLS.
 */
export const AribHlsParams = Type.Object({
  template: Type.Literal('arib-hls'),
  templateVersion: Type.Literal(1),
  video: Type.Object({
    /** selects the filter branch + default GOP: ivtc → 24000/1001, deinterlace/none → 30000/1001 */
    mode: Type.Union([Type.Literal('ivtc'), Type.Literal('deinterlace'), Type.Literal('none')]),
    codec: Type.Optional(Type.Literal('hevc_qsv', { default: 'hevc_qsv' })),
    bitrate: Type.Optional(Type.String({ default: '3M' })),
    /** GOP expression; default derived from `mode` by the template */
    gop: Type.Optional(Type.String()),
    /** QSV encode preset */
    preset: Type.Optional(Type.Integer({ default: 7 })),
  }),
  /** 1..4 audio outputs — drives var_stream_map / rendition generation */
  audio: Type.Array(AribHlsAudio, { minItems: 1, maxItems: 4 }),
  subtitles: Type.Optional(
    Type.Object({
      /** ARIB caption → ASS subtitle playlist */
      enabled: Type.Optional(Type.Boolean({ default: true })),
      language: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
    }),
  ),
  thumbnail: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      width: Type.Optional(Type.Integer()),
      height: Type.Optional(Type.Integer()),
      intervalSec: Type.Optional(Type.Number()),
    }),
  ),
  hls: Type.Optional(
    Type.Object({
      /** hls_time */
      segmentSeconds: Type.Optional(Type.Number({ default: 5 })),
      /** hls_list_size */
      listSize: Type.Optional(Type.Integer({ default: 120 })),
    }),
  ),
});
export type AribHlsParams = Static<typeof AribHlsParams>;

/** future pipeline shapes become new union members */
export const PipelineParams = Type.Union([AribHlsParams]);
export type PipelineParams = Static<typeof PipelineParams>;

// ---------------------------------------------------------------------------
// Desired session / desired state
// ---------------------------------------------------------------------------

export const DesiredSession = Type.Object({
  name: SessionName,
  /** false = stop the process but keep config + output dir */
  enabled: Type.Optional(Type.Boolean({ default: true })),
  source: SessionSource,
  tsreadex: TsreadexParams,
  /** fully resolved — the daemon never resolves profile names */
  pipeline: PipelineParams,
});
export type DesiredSession = Static<typeof DesiredSession>;

/** PUT /v1/desired body — full replacement, all-or-nothing validation. */
export const DesiredState = Type.Object({
  apiVersion: Type.Literal(1),
  /** the controller's doc hash — echoed back as `desiredRevision` in status */
  revision: Type.String({ minLength: 1 }),
  sessions: Type.Array(DesiredSession),
});
export type DesiredState = Static<typeof DesiredState>;

// ---------------------------------------------------------------------------
// Status (daemon → controller, GET /v1/status)
// ---------------------------------------------------------------------------

export const SessionState = Type.Union([
  Type.Literal('starting'),
  Type.Literal('running'),
  Type.Literal('backoff'),
  Type.Literal('stopping'),
  Type.Literal('disabled'),
  /** persisted session no longer passes validation / argv build */
  Type.Literal('invalid'),
]);
export type SessionState = Static<typeof SessionState>;

/**
 * Failure classification of the last exit — drives the backoff policy and is
 * surfaced to the controller UI.
 */
export const ExitClass = Type.Union([
  /** ran ≥60s with progress; quick restart, failure counter reset */
  Type.Literal('healthy'),
  /** tvheadend refused the subscription (HTTP error on the source request) */
  Type.Literal('source-http'),
  Type.Literal('crash'),
  /** output watchdog: no progress / stalled playlist */
  Type.Literal('stall'),
  /** proactive restart after exceeding memoryLimitMb; failure counter reset */
  Type.Literal('oom-guard'),
]);
export type ExitClass = Static<typeof ExitClass>;

export const SessionStatus = Type.Object({
  name: SessionName,
  state: SessionState,
  enabled: Type.Boolean(),
  /** stable hash of the DesiredSession — the reconciler's change detector */
  configHash: Type.String(),
  ffmpegPid: Type.Optional(Type.Integer()),
  tsreadexPid: Type.Optional(Type.Integer()),
  /** ISO 8601 — when the current process generation started */
  startedAt: Type.Optional(Type.String()),
  restarts: Type.Integer(),
  consecutiveFailures: Type.Integer(),
  /** ISO 8601 — next spawn attempt while in backoff */
  nextRetryAt: Type.Optional(Type.String()),
  lastExit: Type.Optional(
    Type.Object({
      code: Type.Union([Type.Integer(), Type.Null()]),
      signal: Type.Union([Type.String(), Type.Null()]),
      /** ISO 8601 */
      at: Type.String(),
      class: ExitClass,
    }),
  ),
  lastError: Type.Optional(Type.String()),
  /** parsed from ffmpeg `-progress pipe:3` */
  progress: Type.Optional(
    Type.Object({
      bitrateKbps: Type.Number(),
      speed: Type.Number(),
      outTimeMs: Type.Number(),
      /** ISO 8601 */
      updatedAt: Type.String(),
    }),
  ),
  /** ffmpeg+tsreadex RSS sampled every 10s (memory guard) */
  memoryRssMb: Type.Optional(Type.Number()),
  /** ISO 8601 — last EXT-X-PROGRAM-DATE-TIME (fallback: newest segment mtime) */
  lastSegmentAt: Type.Optional(Type.String()),
  /** wall-clock lag of the media playlist — the truthful per-session health signal */
  playlistLagSec: Type.Optional(Type.Number()),
  /**
   * PAT-probed program number for the current source. Absent when an explicit
   * `programNumber` was supplied or the probe hasn't succeeded yet.
   */
  detectedProgramNumber: Type.Optional(Type.Integer()),
});
export type SessionStatus = Static<typeof SessionStatus>;

/** GET /v1/status response. */
export const StatusResponse = Type.Object({
  apiVersion: Type.Literal(1),
  daemonVersion: Type.String(),
  /** ISO 8601 */
  startedAt: Type.String(),
  uptimeSec: Type.Number(),
  /** e.g. ['qsv', 'opencl'] — controller matches template requiredCaps against these */
  capabilities: Type.Array(Type.String()),
  /** pipeline templates this daemon can build */
  templates: Type.Array(Type.Object({ id: Type.String(), version: Type.Integer() })),
  /** revision of the persisted desired doc; null when never pushed (controller pushes immediately on mismatch) */
  desiredRevision: Type.Union([Type.String(), Type.Null()]),
  /**
   * Fingerprint of the local sources.m3u catalog — the poller re-fetches
   * `GET /v1/sources` when it changes. Absent = old daemon (no sources API);
   * null = no `sourcesM3u` configured.
   */
  sourcesHash: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  sessions: Type.Array(SessionStatus),
});
export type StatusResponse = Static<typeof StatusResponse>;

// ---------------------------------------------------------------------------
// Sources catalog (GET /v1/sources)
// ---------------------------------------------------------------------------

/**
 * One entry of the daemon's local `sources.m3u` catalog (non-tvheadend
 * sources the controller can target via a `UrlSource` session).
 */
export const SourceCatalogEntry = Type.Object({
  /**
   * Stable entry id — `tvg-id` when present, else a slug derived from the
   * name. Set `tvg-id` for stability: the controller stores this id.
   */
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  url: Type.String({ minLength: 1 }),
  /** `tvg-logo` — emitted verbatim */
  logo: Type.Optional(Type.String()),
  /**
   * `tvg-chno` — REQUIRED. Catalog entries are identity-matched by
   * (name, chno); STRING channel number, same identity conventions as
   * tvheadend channel numbers ("9.1" ≠ "9.10").
   */
  chno: Type.String({ minLength: 1 }),
});
export type SourceCatalogEntry = Static<typeof SourceCatalogEntry>;

/** GET /v1/sources response. */
export const SourcesResponse = Type.Object({
  apiVersion: Type.Literal(1),
  /** stable hash of `entries`; null when no `sourcesM3u` is configured */
  catalogHash: Type.Union([Type.String(), Type.Null()]),
  /** ISO 8601 mtime of the last successful parse; null when never parsed */
  updatedAt: Type.Union([Type.String(), Type.Null()]),
  entries: Type.Array(SourceCatalogEntry),
  /** non-fatal parse warnings (skipped lines, duplicate ids, …) */
  warnings: Type.Optional(Type.Array(Type.String())),
});
export type SourcesResponse = Static<typeof SourcesResponse>;

// ---------------------------------------------------------------------------
// Log tail (GET /v1/sessions/:name/log?lines=N)
// ---------------------------------------------------------------------------

export const LogLine = Type.Object({
  /** ISO 8601 */
  ts: Type.String(),
  /** which child produced the line */
  src: Type.Union([Type.Literal('ffmpeg'), Type.Literal('tsreadex'), Type.Literal('daemon')]),
  line: Type.String(),
});
export type LogLine = Static<typeof LogLine>;

// ---------------------------------------------------------------------------
// Switcher contract (controller → switcher / switcher → controller)
//
// The switcher is the second deployable in this repo: it splices the active
// upstream's HLS playlists for redundant (multi-placement) channels and fails
// over autonomously with EXT-X-DISCONTINUITY. Same autonomy pattern as the
// daemon: desired state persisted locally, serving survives controller
// outages and its own restarts.
// ---------------------------------------------------------------------------

/** One encode of a redundant channel on one node. */
export const SwitcherUpstream = Type.Object({
  /** controller-side placement id */
  id: Type.String({ minLength: 1 }),
  /** channel base URL on the node: `<node serveUrl>/<slug>` */
  url: Type.String({ minLength: 1 }),
  /** failover order — lower is preferred */
  priority: Type.Integer(),
});
export type SwitcherUpstream = Static<typeof SwitcherUpstream>;

export const SwitcherChannel = Type.Object({
  /** URL path segment: `GET /hls/<slug>/playlist.m3u8` */
  slug: SessionName,
  /** hls_time of the upstream encodes — drives the stall threshold and virtual MEDIA-SEQUENCE derivation */
  segmentSeconds: Type.Number(),
  upstreams: Type.Array(SwitcherUpstream, { minItems: 1 }),
});
export type SwitcherChannel = Static<typeof SwitcherChannel>;

/** PUT /v1/desired body (switcher) — full replace, atomic persist, all-or-nothing validation. */
export const SwitcherDesiredState = Type.Object({
  apiVersion: Type.Literal(1),
  /** the controller's doc hash */
  revision: Type.String({ minLength: 1 }),
  channels: Type.Array(SwitcherChannel),
});
export type SwitcherDesiredState = Static<typeof SwitcherDesiredState>;

export const SwitchReason = Type.Union([
  /** autonomous: active upstream unhealthy → highest-priority healthy one */
  Type.Literal('failover'),
  /** POST /v1/channels/:slug/switch (UI button / controller rebalance) */
  Type.Literal('manual'),
  /** active upstream disappeared from a pushed desired doc */
  Type.Literal('push'),
]);
export type SwitchReason = Static<typeof SwitchReason>;

export const SwitcherChannelStatus = Type.Object({
  slug: SessionName,
  /** null while no healthy upstream has ever been selected */
  activeUpstreamId: Type.Union([Type.String(), Type.Null()]),
  upstreams: Type.Array(
    Type.Object({
      id: Type.String(),
      healthy: Type.Boolean(),
      /** wall-clock lag of the upstream's media playlist PDT */
      playlistLagSec: Type.Optional(Type.Number()),
    }),
  ),
  lastSwitch: Type.Union([
    Type.Object({
      /** ISO 8601 */
      at: Type.String(),
      from: Type.Union([Type.String(), Type.Null()]),
      to: Type.String(),
      reason: SwitchReason,
    }),
    Type.Null(),
  ]),
});
export type SwitcherChannelStatus = Static<typeof SwitcherChannelStatus>;

/** GET /v1/status response (switcher). */
export const SwitcherStatus = Type.Object({
  apiVersion: Type.Literal(1),
  switcherVersion: Type.String(),
  /** ISO 8601 */
  startedAt: Type.String(),
  uptimeSec: Type.Number(),
  /** revision of the persisted desired doc; null when never pushed (e.g. after PVC loss — controller pushes immediately) */
  desiredRevision: Type.Union([Type.String(), Type.Null()]),
  channels: Type.Array(SwitcherChannelStatus),
});
export type SwitcherStatus = Static<typeof SwitcherStatus>;

/** POST /v1/channels/:slug/switch body. */
export const SwitchCommand = Type.Object({
  upstreamId: Type.String({ minLength: 1 }),
});
export type SwitchCommand = Static<typeof SwitchCommand>;
