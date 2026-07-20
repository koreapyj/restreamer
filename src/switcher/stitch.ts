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
 * The splice core: virtual HLS playlists over redundant upstreams.
 *
 * A channel has N hot-hot upstream encodes (same profile ⇒ identical
 * variant/rendition layout). Viewers play one stable switcher URL; this
 * module mirrors the ACTIVE upstream's playlists with:
 *   - master:  variant/rendition URIs kept RELATIVE to the master's own URL
 *              (`<variant>/stream.m3u8`) so they resolve to the switcher's
 *              media routes wherever a reverse proxy mounts it,
 *   - media:   segment / EXT-X-MAP URIs rewritten to ABSOLUTE upstream URLs
 *              (playlists are tied to the upstream host; viewers fetch
 *              segment bytes node→viewer directly — the switcher serves only
 *              small text), and MEDIA-SEQUENCE / DISCONTINUITY-SEQUENCE are
 *              replaced by virtual values with an EXT-X-DISCONTINUITY
 *              spliced in at switch points.
 *
 * ── Served-window buffer (retain the outgoing tail across a switch) ─────────
 *
 * Per (channel, variant) we keep a rolling buffer of the segments currently in
 * the served window (oldest → newest), each with a virtual sequence assigned
 * once at append time. Every render we MERGE the active upstream's playlist in
 * rather than re-deriving from it:
 *
 *   1. Append the genuinely-new active segments — those past this variant's
 *      append cutoff (PDT end in the common case, raw MEDIA-SEQUENCE without
 *      PDT). Right after a switch the cutoff is where the OLD upstream left
 *      off, so the new upstream's parallel backlog is skipped (the splice) and
 *      only content past the splice point is appended.
 *   2. Hold the window at its pre-switch length while a prior upstream's tail
 *      is still draining (never collapse), else track the active window length.
 *   3. Trim the front to that target, aging out the oldest segments.
 *
 * This retains the outgoing upstream's already-served segments AHEAD of the
 * discontinuity and drains them one-per-new-segment, so the window stays a
 * constant size and players keep their position — instead of the served
 * playlist collapsing to the new upstream's post-splice remainder. Retained
 * segment URIs keep pointing at the outgoing upstream's absolute URL, which
 * stays resolvable because the node defers deleting a removed session's HLS
 * window for ≈ segmentSeconds × listSize (the daemon's cleanupDelaySec) — the
 * same horizon over which the tail drains here.
 *
 *   Virtual MEDIA-SEQUENCE = buf[0].virtualSeq.
 *   Monotonic by construction: virtual sequences only ever increase (assigned
 *   once, never reused) and we only append to the back / trim from the front.
 *   Across the retained→new boundary the sequence is literally contiguous (no
 *   re-anchor jump). An empty buffer (fresh process / restart) seeds the next
 *   sequence to timeBase(now) = floor(nowMs / 1000 / segmentSeconds): real-time
 *   encoders slide ≤ 1 segment per segmentSeconds of wall clock and a restart
 *   takes longer, so the new base lands at or ahead of anything served before.
 *
 *   Virtual DISCONTINUITY-SEQUENCE = count of discontinuities that have aged
 *   off the front (RFC 8216). A switch flags the first appended new-upstream
 *   segment with an EXT-X-DISCONTINUITY; upstream-origin discontinuities
 *   (encoder restarts, discont_start) fold into the same per-segment flag.
 *   The base is seeded from the upstream's value on the first render and bumped
 *   as flagged segments slide out.
 *
 * ── Health probing (no autonomous failover) ────────────────────────────────
 *
 * An upstream is unhealthy when a playlist fetch fails (non-2xx / network
 * error) or its media playlist's last PDT lags wall clock by more than
 * 3 × segmentSeconds + stallGraceSec. Health is (re)evaluated on every
 * on-demand fetch of the ACTIVE upstream; probeAll() (driven by a timer in
 * main.ts) checks every upstream of every channel so status stays fresh, and
 * applyDesired() eagerly probes never-checked upstreams so a just-pushed
 * upstream gets a health+lag reading quickly. A channel flagged
 * onDemandIdle (its encode is intentionally down) is skipped by both — see
 * "On-demand idle channels" below.
 *
 * The switcher NEVER switches on its own health judgment: the controller is
 * the sole failover authority and drives every switch either with a WS
 * 'switch' frame or by naming the intended upstream in a pushed doc's
 * channel.activeUpstreamId — both go through doSwitch, so the splice point
 * and discontinuity bookkeeping are identical either way. When a doc omits
 * activeUpstreamId the current selection is kept if its upstream survived,
 * or re-picked deterministically if it didn't (leaving activeUpstreamId
 * dangling would break segment resolution). When the active upstream is
 * unhealthy the channel stays put — a stale-but-fetchable playlist is still
 * served, a failed fetch surfaces as UpstreamUnavailableError (HTTP 503
 * upstairs) until the controller orders a switch.
 *
 * ── On-demand idle channels ──────────────────────────────────────────────
 *
 * A channel's `onDemandIdle` flag means its encode is intentionally not
 * running (nothing is watching it right now) — its upstreams are expected
 * to be unreachable, so health probing is skipped rather than logging churn
 * for a down encode nobody asked to bring up. The switcher never decides
 * this itself: it only reflects `SwitcherChannel.onDemandIdle` from the
 * pushed doc.
 *
 * ── On-demand cold-start hold ─────────────────────────────────────────────
 *
 * `onDemand` marks a channel whose encode starts on viewer demand; unlike
 * `onDemandIdle` it stays true through bring-up (a failover row can exist
 * while the encode is still starting, which already drops `onDemandIdle`).
 * server.ts holds a viewer's playlist request open on such a channel instead
 * of 503ing when the upstream isn't reachable yet, via `waitServeable()`:
 * it polls the active upstream until its master AND at least one variant it
 * lists fetch OK with a real segment, deliberately WITHOUT calling
 * markHealth — same rationale as onDemandIdle skipping probes, a down
 * encode nobody's told to come up yet shouldn't churn health transitions.
 * The demand note (server.ts, `link.noteDemand`) still fires on request
 * arrival, before the hold — that's what wakes the encode in the first
 * place, so it must not wait on the very thing it's supposed to trigger.
 *
 * Pure-ish: fetch and clock are injected; no filesystem access and no
 * persistence — a fresh instance derives its active selection entirely from
 * the pushed doc's `activeUpstreamId` (see applyDesired).
 */

import type {
  EraAnchor,
  SwitcherChannel,
  SwitcherChannelStatus,
  SwitcherDesiredState,
  SwitcherUpstream,
  SwitchReason,
} from '../contract/v1.js';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export class UnknownChannelError extends Error {}
export class UnknownVariantError extends Error {}
export class UnknownUpstreamError extends Error {}
export class UpstreamUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryAfterSec: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// M3U8 parsing / rendering
// ---------------------------------------------------------------------------

interface ParsedSegment {
  /** tag lines attached to this segment (EXTINF, PDT, KEY, upstream DISCONTINUITY, …), verbatim */
  tags: string[];
  uri: string;
  durationSec: number;
  /** explicit or extrapolated from the previous segment; null when the playlist has no PDT at all */
  pdtMs: number | null;
}

interface ParsedMedia {
  /** header lines, verbatim, excluding #EXTM3U / MEDIA-SEQUENCE / DISCONTINUITY-SEQUENCE / ENDLIST */
  headerLines: string[];
  mediaSequence: number;
  discontinuitySequence: number;
  segments: ParsedSegment[];
  endList: boolean;
  /** pdt + duration of the last segment; null without PDT */
  lastPdtEndMs: number | null;
}

const HEADER_TAGS = [
  '#EXT-X-VERSION',
  '#EXT-X-TARGETDURATION',
  '#EXT-X-PLAYLIST-TYPE',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-START',
  '#EXT-X-ALLOW-CACHE',
  '#EXT-X-MAP',
];

function isHeaderTag(line: string): boolean {
  return HEADER_TAGS.some((t) => line === t || line.startsWith(`${t}:`));
}

export function parseMediaPlaylist(text: string): ParsedMedia {
  const headerLines: string[] = [];
  const segments: ParsedSegment[] = [];
  let mediaSequence = 0;
  let discontinuitySequence = 0;
  let endList = false;
  let pending: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === '' || line === '#EXTM3U') continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number.parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
      discontinuitySequence = Number.parseInt(line.slice('#EXT-X-DISCONTINUITY-SEQUENCE:'.length), 10) || 0;
      continue;
    }
    if (line === '#EXT-X-ENDLIST') {
      endList = true;
      continue;
    }
    if (line.startsWith('#')) {
      if (isHeaderTag(line)) headerLines.push(line);
      else pending.push(line);
      continue;
    }
    // URI line — closes a segment
    let durationSec = 0;
    let pdtMs: number | null = null;
    for (const tag of pending) {
      if (tag.startsWith('#EXTINF:')) durationSec = Number.parseFloat(tag.slice('#EXTINF:'.length)) || 0;
      else if (tag.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
        const parsed = Date.parse(tag.slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
        if (!Number.isNaN(parsed)) pdtMs = parsed;
      }
    }
    segments.push({ tags: pending, uri: line, durationSec, pdtMs });
    pending = [];
  }

  // extrapolate missing PDTs from the previous segment
  let cursor: number | null = null;
  for (const seg of segments) {
    if (seg.pdtMs !== null) cursor = seg.pdtMs;
    else if (cursor !== null) seg.pdtMs = cursor;
    if (cursor !== null) cursor += seg.durationSec * 1000;
  }
  const last = segments.at(-1);
  const lastPdtEndMs = last && last.pdtMs !== null ? last.pdtMs + last.durationSec * 1000 : null;

  return { headerLines, mediaSequence, discontinuitySequence, segments, endList, lastPdtEndMs };
}

function isAbsoluteUri(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

function rewriteUriAttr(line: string, rewrite: (uri: string) => string): string {
  return line.replace(/URI="([^"]*)"/, (_m, uri: string) => `URI="${rewrite(uri)}"`);
}

/**
 * Builds the segment / EXT-X-MAP URI rewriter for one upstream + variant:
 * everything is absolutized against the upstream base (relative URIs get the
 * base prepended; already-absolute URIs pass through verbatim).
 */
function segmentRewriter(base: string): (uri: string) => string {
  return (uri: string) => (isAbsoluteUri(uri) ? uri : `${base}/${uri}`);
}

/**
 * Rewrites a master playlist: relative `<variant>/stream.m3u8` URIs (variant
 * playlists AND audio/subtitle rendition URI attributes) stay RELATIVE to
 * the master's own URL — they resolve to the switcher's media routes
 * wherever a reverse proxy mounts it; other relative URIs are absolutized
 * against the upstream; absolute URIs and every non-URI line pass through
 * verbatim.
 */
export function rewriteMasterPlaylist(
  text: string,
  upstreamUrl: string,
): { text: string; variants: string[] } {
  const variants: string[] = [];
  const rewrite = (uri: string): string => {
    if (isAbsoluteUri(uri)) return uri;
    const m = /^(.+)\/stream\.m3u8$/.exec(uri);
    if (m?.[1]) {
      variants.push(m[1]);
      return `${m[1]}/stream.m3u8`;
    }
    return `${upstreamUrl}/${uri}`;
  };
  const lines = text.split(/\r?\n/).map((line) => {
    if (line.startsWith('#')) return line.includes('URI="') ? rewriteUriAttr(line, rewrite) : line;
    if (line.trim() === '') return line;
    return rewrite(line.trim());
  });
  return { text: lines.join('\n'), variants };
}

// ---------------------------------------------------------------------------
// Stitcher state
// ---------------------------------------------------------------------------

interface UpstreamHealth {
  healthy: boolean;
  playlistLagSec?: number;
  /** null = never checked (optimistic) */
  checkedAt: number | null;
  lastError?: string;
}

/**
 * A segment's position in the era model: which controller-minted era it
 * belongs to (by PDT membership) and its globally-consecutive label
 * (`rawSeq + C_v(eraIndex)`). Fixed once at append time, never recomputed —
 * see the "Era numbering" section of the module header.
 */
interface EraPosition {
  eraIndex: number;
  label: number;
}

/** one segment in the switcher's served window (already URI-rewritten) */
interface BufSeg {
  /** verbatim segment tags MINUS any #EXT-X-DISCONTINUITY (folded into `disc`) */
  tags: string[];
  /** rewritten URI, emitted verbatim — carries the SOURCE upstream id */
  uri: string;
  /** assigned once, at append time; the served MEDIA-SEQUENCE is buf[0].virtualSeq (legacy path) */
  virtualSeq: number;
  /** an EXT-X-DISCONTINUITY precedes this segment (splice boundary OR upstream-origin) */
  disc: boolean;
  /** pdt + duration, for append dedup / splice cutoff; null without PDT */
  pdtEndMs: number | null;
  /** source media-sequence index, for the no-PDT append fallback */
  rawSeq: number;
  /** provenance — a mismatch with the active id means we're draining this segment */
  upstreamId: string;
  /** era membership + label (era path only); null when this variant is on the legacy path */
  era: EraPosition | null;
}

/**
 * Per-variant served window. The switcher maintains its own rolling buffer
 * (oldest → newest) instead of re-deriving from the active upstream each
 * render, so a switch retains the outgoing tail ahead of the discontinuity and
 * drains it gradually — the window never collapses. See the module header.
 */
interface VariantState {
  buf: BufSeg[];
  /** id of the newest appended segment; a mismatch with the active id ⇒ a switch boundary */
  lastUpstreamId: string | null;
  /** virtualSeq for the next appended segment (monotonic, never reused); legacy path only, but always kept ticking */
  nextVirtual: number;
  /** served DISCONTINUITY-SEQUENCE base = count of discontinuities aged off the front (legacy path only) */
  discSeq: number;
  /** append cutoff (PDT mode); == the splice point right after a switch */
  lastPdtEndMs: number | null;
  /** append cutoff (no-PDT fallback) */
  lastRawSeq: number | null;
  /** eraIndex -> C_v, the per-era chain constant (label = rawSeq + C_v); doc-adopted values override local derivation */
  chain: Map<number, number>;
  /**
   * Sticky, decided once per VariantState instance: undefined = not yet
   * decided (buffer still empty); true = committed to the era path for the
   * rest of this instance's life; false = committed to the legacy path
   * (anchors absent, chain underivable at bootstrap, or eras only became
   * available after this variant already had legacy-numbered content
   * buffered — never retroactively relabeled). See "Era numbering" below.
   */
  eraCapable: boolean | undefined;
}

interface ChannelState {
  channel: SwitcherChannel;
  activeUpstreamId: string | null;
  lastSwitch: { at: string; from: string | null; to: string; reason: SwitchReason } | null;
  /** recent eras (initial activation | switch) — doc full-replace wins over locally WS-merged anchors */
  eras: EraAnchor[];
  /** PDT end of the newest segment ever served for this channel (any variant) */
  lastServedPdtEndMs: number | null;
  knownVariants: Set<string>;
  health: Map<string, UpstreamHealth>;
  variants: Map<string, VariantState>;
  /** mirrors SwitcherChannel.onDemandIdle, refreshed on every applyDesired — see the module header */
  onDemandIdle: boolean;
  /** mirrors SwitcherChannel.onDemand, refreshed on every applyDesired — see the module header */
  onDemand: boolean;
}

/**
 * Segment belongs to era e iff pdtEnd > splicePdtMs(e) and (no era e+1 or
 * pdtEnd <= splicePdtMs(e+1)) — equivalently the greatest eraIndex whose
 * splicePdtMs is null (era 0, no lower bound) or strictly before pdtEndMs.
 * Returns null when no known era covers the timestamp (predates the drain
 * horizon carried in the doc, or no anchors at all).
 */
function classifyEra(eras: EraAnchor[], pdtEndMs: number): number | null {
  let best: number | null = null;
  for (const e of eras) {
    if (e.splicePdtMs === null || pdtEndMs > e.splicePdtMs) {
      if (best === null || e.eraIndex > best) best = e.eraIndex;
    }
  }
  return best;
}

/** Pre-seeds a variant's chain map from doc-carried offsets (disagreement rule 2: doc value overrides local derivation). */
function seedChainFromEras(eras: EraAnchor[], variant: string, chain: Map<number, number>): void {
  for (const era of eras) {
    const c = era.offsets?.[variant];
    if (c !== undefined) chain.set(era.eraIndex, c);
  }
}

interface CacheEntry {
  at: number;
  ok: boolean;
  status: number;
  text: string;
  error?: string;
}

export interface StitcherOptions {
  cacheTtlMs: number;
  stallGraceSec: number;
  fetchImpl?: typeof fetch;
  /** injectable clock (ms since epoch) */
  now?: () => number;
  logger?: Logger;
}

const NULL_LOGGER: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export class Stitcher {
  private readonly cacheTtlMs: number;
  private readonly stallGraceSec: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly logger: Logger;

  private channels = new Map<string, ChannelState>();
  private desired: SwitcherDesiredState | null = null;
  private cache = new Map<string, CacheEntry>();

  constructor(opts: StitcherOptions) {
    this.cacheTtlMs = opts.cacheTtlMs;
    this.stallGraceSec = opts.stallGraceSec;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger ?? NULL_LOGGER;
  }

  get desiredRevision(): string | null {
    return this.desired?.revision ?? null;
  }

  getDesired(): SwitcherDesiredState | null {
    return this.desired;
  }

  /** mirrors SwitcherChannel.onDemand for the given channel; false for an unknown slug */
  isOnDemand(slug: string): boolean {
    return this.channels.get(slug)?.onDemand ?? false;
  }

  // -------------------------------------------------------------------------
  // Desired state
  // -------------------------------------------------------------------------

  /**
   * Full replace. Selection policy per channel:
   *   - `channel.activeUpstreamId`, when present and naming a surviving
   *     upstream, wins: a real switch (doSwitch, reason 'push') when it
   *     differs from the current active upstream, else a plain initial pick;
   *   - otherwise the current in-memory active upstream is kept if it
   *     survived;
   *   - else (no prior selection, or its upstream was removed) the
   *     highest-priority healthy upstream — or the highest-priority one — is
   *     picked, reason 'push';
   *   - removed channels are dropped.
   */
  applyDesired(doc: SwitcherDesiredState): void {
    const next = new Map<string, ChannelState>();

    for (const channel of doc.channels) {
      const prev = this.channels.get(channel.slug);
      const st: ChannelState = prev ?? {
        channel,
        activeUpstreamId: null,
        lastSwitch: null,
        eras: [],
        lastServedPdtEndMs: null,
        knownVariants: new Set(),
        health: new Map(),
        variants: new Map(),
        onDemandIdle: false,
        onDemand: false,
      };
      st.channel = channel;
      st.onDemandIdle = channel.onDemandIdle ?? false;
      st.onDemand = channel.onDemand ?? false;
      // doc full-replace wins over any locally WS-merged switch-frame anchors —
      // the controller's persisted view is authoritative. A late-joining
      // replica seeds its per-variant chain constants directly from
      // doc-carried offsets (disagreement rule 2) so its first render matches
      // an already-running replica's; existing variants get any newer
      // doc-adopted offsets too, overriding local derivation.
      st.eras = channel.eras ?? [];
      for (const [variantName, vs] of st.variants) {
        seedChainFromEras(st.eras, variantName, vs.chain);
      }

      const ids = new Set(channel.upstreams.map((u) => u.id));
      const health = new Map<string, UpstreamHealth>();
      for (const up of channel.upstreams) {
        health.set(up.id, st.health.get(up.id) ?? { healthy: true, checkedAt: null });
      }
      st.health = health;

      const pushed =
        channel.activeUpstreamId !== undefined && ids.has(channel.activeUpstreamId)
          ? channel.activeUpstreamId
          : undefined;

      if (pushed !== undefined) {
        // the doc names the intended active upstream explicitly — the same
        // real switch as a WS 'switch' frame, or a plain initial pick when
        // nothing was active yet
        if (st.activeUpstreamId !== null && st.activeUpstreamId !== pushed) {
          this.doSwitch(st, pushed, 'push');
        } else {
          st.activeUpstreamId = pushed;
        }
      } else if (st.activeUpstreamId === null || !ids.has(st.activeUpstreamId)) {
        // no prior selection, or its upstream was removed — pick anew
        const sorted = [...channel.upstreams].sort((a, b) => a.priority - b.priority);
        const healthyFirst = sorted.find((u) => st.health.get(u.id)?.healthy !== false) ?? sorted[0];
        if (!healthyFirst) continue; // unreachable: upstreams has minItems 1
        if (st.activeUpstreamId !== null) {
          // active upstream disappeared from the doc → this is a real switch
          st.lastSwitch = {
            at: new Date(this.now()).toISOString(),
            from: st.activeUpstreamId,
            to: healthyFirst.id,
            reason: 'push',
          };
        }
        st.activeUpstreamId = healthyFirst.id;
      }
      // else: active upstream survived the push — keep serving it untouched
      next.set(channel.slug, st);
    }

    this.channels = next;
    this.desired = doc;
    this.cache.clear();
    this.probeNeverChecked();
  }

  // -------------------------------------------------------------------------
  // Switching
  // -------------------------------------------------------------------------

  /**
   * Manual/API switch. Throws UnknownChannelError / UnknownUpstreamError.
   * `era` (from a WS 'switch' frame) is merged into the channel's known eras
   * even when the switch itself is a no-op (already active) — the frame is
   * meant to apply idempotently, same as the next doc broadcast.
   */
  switchTo(slug: string, upstreamId: string, reason: SwitchReason, era?: EraAnchor): void {
    const ch = this.requireChannel(slug);
    if (!ch.channel.upstreams.some((u) => u.id === upstreamId)) {
      throw new UnknownUpstreamError(`unknown upstream ${upstreamId} for channel ${slug}`);
    }
    if (ch.activeUpstreamId === upstreamId) {
      if (era) this.mergeEra(ch, era);
      return;
    }
    this.doSwitch(ch, upstreamId, reason, era);
  }

  private doSwitch(ch: ChannelState, toId: string, reason: SwitchReason, era?: EraAnchor): void {
    const from = ch.activeUpstreamId;
    const at = new Date(this.now()).toISOString();
    ch.activeUpstreamId = toId;
    ch.lastSwitch = { at, from, to: toId, reason };
    if (era) this.mergeEra(ch, era);
    this.logger.info(`channel ${ch.channel.slug}: switched ${from ?? '(none)'} → ${toId} (${reason})`);
  }

  /** Upserts a controller-minted anchor into the channel's locally-known eras (by eraIndex), kept ascending. */
  private mergeEra(ch: ChannelState, era: EraAnchor): void {
    const idx = ch.eras.findIndex((e) => e.eraIndex === era.eraIndex);
    if (idx >= 0) ch.eras[idx] = era;
    else ch.eras.push(era);
    ch.eras.sort((a, b) => a.eraIndex - b.eraIndex);
  }

  // -------------------------------------------------------------------------
  // Playlist serving
  // -------------------------------------------------------------------------

  async getMasterPlaylist(slug: string): Promise<string> {
    const ch = this.requireChannel(slug);
    const upstream = this.activeUpstream(ch);
    const res = await this.cachedFetch(upstream, 'playlist.m3u8');
    if (res.ok) {
      // master has no PDT — fetch success alone marks reachable; preserve any known lag
      this.markHealth(ch, upstream.id, true, ch.health.get(upstream.id)?.playlistLagSec ?? null);
      const { text, variants } = rewriteMasterPlaylist(res.text, upstream.url);
      for (const v of variants) ch.knownVariants.add(v);
      return text;
    }
    // no autonomous failover: surface the failure and wait for the controller
    this.markHealth(ch, upstream.id, false, null, res.error ?? `HTTP ${res.status}`);
    throw new UpstreamUnavailableError(
      `channel ${slug}: active upstream unavailable (${upstream.id}: ${res.error ?? `HTTP ${res.status}`})`,
      Math.ceil(ch.channel.segmentSeconds),
    );
  }

  async getMediaPlaylist(slug: string, variant: string): Promise<string> {
    const ch = this.requireChannel(slug);
    // Variant oracle: once the master has been seen (on demand or by probe),
    // reject variants it doesn't list — an upstream 404 for a nonsense path
    // must not trigger failover. Before anything is learned we can't
    // distinguish, so the request is attempted (restart with viewers mid-play).
    if (ch.knownVariants.size > 0 && !ch.knownVariants.has(variant)) {
      throw new UnknownVariantError(`unknown variant ${variant} for channel ${slug}`);
    }
    const upstream = this.activeUpstream(ch);
    const res = await this.cachedFetch(upstream, `${variant}/stream.m3u8`);
    if (res.ok) {
      const parsed = parseMediaPlaylist(res.text);
      const lagSec = parsed.lastPdtEndMs !== null ? Math.max(0, (this.now() - parsed.lastPdtEndMs) / 1000) : null;
      const stale = lagSec !== null && lagSec > this.staleThresholdSec(ch);
      if (!stale) {
        this.markHealth(ch, upstream.id, true, lagSec);
      } else {
        // no autonomous failover: keep serving the stale content until the
        // controller orders a switch — better a lagging picture than none
        this.markHealth(ch, upstream.id, false, lagSec, `stale playlist (lag ${lagSec.toFixed(1)}s)`);
      }
      return this.renderForVariant(ch, variant, upstream, parsed);
    }
    this.markHealth(ch, upstream.id, false, null, res.error ?? `HTTP ${res.status}`);
    throw new UpstreamUnavailableError(
      `channel ${slug}/${variant}: active upstream unavailable (${upstream.id}: ${res.error ?? `HTTP ${res.status}`})`,
      Math.ceil(ch.channel.segmentSeconds),
    );
  }

  // -------------------------------------------------------------------------
  // On-demand cold-start hold
  // -------------------------------------------------------------------------

  /**
   * Polls the channel's active upstream until its master playlist fetches OK
   * AND at least one variant it lists fetches OK with ≥1 segment, or until
   * timeoutMs elapses — server.ts calls this to hold a viewer's playlist
   * request open on an `onDemand` channel instead of 503ing while the encode
   * is still starting up. Never throws: a fetch failure is the expected
   * state while waiting, not an error condition. Resolves early to `false`
   * if `signal` aborts (the viewer disconnected — see server.ts).
   *
   * Polls through the shared cachedFetch micro-cache rather than bypassing
   * it: polling faster than cacheTtlMs would just replay the same cached
   * result, so the interval is aligned to cacheTtlMs (floored at 1s) instead
   * — and a probe that turns up serveable leaves a warm cache entry that the
   * caller's own post-hold retry fetch usually lands on for free. Uses the
   * plain cachedFetch/parse path, never markHealth: this is expected-down
   * polling, not a health check, so it must not churn health transitions the
   * way a normal fetch failure would (mirrors onDemandIdle skipping probes).
   */
  async waitServeable(slug: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const ch = this.requireChannel(slug);
    const pollIntervalMs = Math.max(1000, this.cacheTtlMs);
    const deadline = this.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) return false;
      if (await this.probeServeableOnce(ch)) return true;
      if (signal?.aborted) return false;
      const remaining = deadline - this.now();
      if (remaining <= 0) return false;
      await delay(Math.min(pollIntervalMs, remaining), signal);
    }
  }

  /** one serveability check, deliberately bypassing markHealth — see waitServeable */
  private async probeServeableOnce(ch: ChannelState): Promise<boolean> {
    const upstream = this.activeUpstream(ch);
    const master = await this.cachedFetch(upstream, 'playlist.m3u8');
    if (!master.ok) return false;
    const { variants } = rewriteMasterPlaylist(master.text, upstream.url);
    for (const variant of variants) {
      const media = await this.cachedFetch(upstream, `${variant}/stream.m3u8`);
      if (media.ok && parseMediaPlaylist(media.text).segments.length > 0) {
        for (const v of variants) ch.knownVariants.add(v);
        return true;
      }
    }
    return false;
  }

  /**
   * Merges the freshly parsed upstream playlist into the variant's served
   * window (see the module header). New active segments are appended —
   * labeled via the era path when the channel has controller-minted anchors
   * and this variant's chain constants are derivable, else via the legacy
   * monotonic virtual sequence (byte-for-byte the original algorithm). A
   * switch/era-seam attaches an EXT-X-DISCONTINUITY to the first
   * post-boundary segment and RETAINS the outgoing tail so the window drains
   * gradually instead of collapsing. The window is held at its pre-switch
   * length while draining, then tracks the active upstream.
   */
  private renderForVariant(
    ch: ChannelState,
    variant: string,
    upstream: SwitcherUpstream,
    parsed: ParsedMedia,
  ): string {
    const nowMs = this.now();
    let vs = ch.variants.get(variant);
    if (!vs) {
      vs = {
        buf: [],
        lastUpstreamId: null,
        // seed to the same time-derived base the old anchor used, so first-render
        // output and cross-restart monotonicity are preserved
        nextVirtual: Math.floor(nowMs / 1000 / ch.channel.segmentSeconds),
        discSeq: parsed.discontinuitySequence,
        lastPdtEndMs: null,
        lastRawSeq: null,
        chain: new Map(),
        eraCapable: undefined,
      };
      seedChainFromEras(ch.eras, variant, vs.chain);
      ch.variants.set(variant, vs);
    }
    const state = vs;

    const rewrite = segmentRewriter(`${trimSlash(upstream.url)}/${variant}`);
    const prevLen = state.buf.length;
    const boundary = state.lastUpstreamId !== null && state.lastUpstreamId !== upstream.id;
    const hasPdt = parsed.segments.some((s) => s.pdtMs !== null);

    // select genuinely-new active segments (past this variant's append cutoff).
    // PDT mode is the splice rule: after a switch, drop the new upstream's
    // parallel backlog and resume exactly where we left off. UNCHANGED by the
    // era path: labels never drive admission.
    const fresh: { seg: ParsedSegment; rawSeq: number }[] = [];
    parsed.segments.forEach((seg, i) => {
      const rawSeq = parsed.mediaSequence + i;
      const isNew =
        hasPdt && seg.pdtMs !== null
          ? state.lastPdtEndMs === null || seg.pdtMs + seg.durationSec * 1000 > state.lastPdtEndMs
          : state.lastRawSeq === null || boundary || rawSeq > state.lastRawSeq;
      if (isNew) fresh.push({ seg, rawSeq });
    });

    // Decide (once, stickily) whether this variant renders via the era path.
    // Only ever COMMIT to era mode while the buffer is still empty — bailing
    // out mid-life (eras arriving after this variant already has
    // legacy-numbered content buffered) would otherwise mix two numbering
    // schemes in the same window; that variant instance stays legacy until a
    // fresh one is created (channel/process restart).
    let labeled: { seg: ParsedSegment; rawSeq: number; eraIndex: number; label: number }[] | null = null;
    if (ch.eras.length > 0 && state.eraCapable !== false) {
      if (state.eraCapable === true) {
        labeled = this.labelEraBatch(ch, variant, state, fresh, false);
      } else if (state.buf.length === 0) {
        if (fresh.length > 0) {
          const trial = this.labelEraBatch(ch, variant, state, fresh, true);
          if (trial !== null) {
            labeled = trial;
            state.eraCapable = true;
          } else {
            state.eraCapable = false;
          }
        }
        // else: nothing to decide yet from an empty fetch — stays undecided
      } else {
        // legacy content already buffered without ever attempting era mode
        // (eras appeared only after this variant was already serving) — commit
        // to legacy for the rest of this instance's life
        state.eraCapable = false;
      }
    }
    const useEra = state.eraCapable === true && labeled !== null;

    if (useEra) {
      let prevEra = state.buf.length > 0 ? state.buf[state.buf.length - 1]!.era!.eraIndex : null;
      for (const { seg, rawSeq, eraIndex, label } of labeled!) {
        const upstreamDisc = seg.tags.some((t) => t === '#EXT-X-DISCONTINUITY');
        const eraChanged = prevEra !== null && prevEra !== eraIndex;
        state.buf.push({
          tags: upstreamDisc ? seg.tags.filter((t) => t !== '#EXT-X-DISCONTINUITY') : seg.tags,
          uri: rewrite(seg.uri),
          virtualSeq: state.nextVirtual++,
          disc: eraChanged || upstreamDisc,
          pdtEndMs: seg.pdtMs !== null ? seg.pdtMs + seg.durationSec * 1000 : null,
          rawSeq,
          upstreamId: upstream.id,
          era: { eraIndex, label },
        });
        prevEra = eraIndex;
      }
      if (labeled!.length > 0) {
        const last = labeled![labeled!.length - 1]!;
        state.lastUpstreamId = upstream.id;
        state.lastRawSeq = last.rawSeq;
        if (last.seg.pdtMs !== null) state.lastPdtEndMs = last.seg.pdtMs + last.seg.durationSec * 1000;
      }
    } else {
      // legacy path — byte-for-byte the original algorithm
      fresh.forEach(({ seg, rawSeq }, idx) => {
        const upstreamDisc = seg.tags.some((t) => t === '#EXT-X-DISCONTINUITY');
        state.buf.push({
          tags: upstreamDisc ? seg.tags.filter((t) => t !== '#EXT-X-DISCONTINUITY') : seg.tags,
          uri: rewrite(seg.uri),
          virtualSeq: state.nextVirtual++,
          disc: (boundary && idx === 0) || upstreamDisc,
          pdtEndMs: seg.pdtMs !== null ? seg.pdtMs + seg.durationSec * 1000 : null,
          rawSeq,
          upstreamId: upstream.id,
          era: null,
        });
      });
      if (fresh.length > 0) {
        const last = fresh[fresh.length - 1]!;
        state.lastUpstreamId = upstream.id;
        state.lastRawSeq = last.rawSeq;
        if (last.seg.pdtMs !== null) state.lastPdtEndMs = last.seg.pdtMs + last.seg.durationSec * 1000;
      }
    }

    // hold the window at its pre-switch length while a prior upstream's tail is
    // still draining (so it can never collapse); otherwise track the active
    // upstream's own window length.
    const draining = state.buf.some((b) => b.upstreamId !== upstream.id);
    const target = draining ? Math.max(1, parsed.segments.length, prevLen) : Math.max(1, parsed.segments.length);
    while (state.buf.length > target) {
      const gone = state.buf.shift();
      if (gone?.disc) state.discSeq += 1; // a discontinuity left the window (RFC 8216); legacy path only, but harmless to keep ticking
    }

    if (parsed.lastPdtEndMs !== null) {
      ch.lastServedPdtEndMs = Math.max(ch.lastServedPdtEndMs ?? 0, parsed.lastPdtEndMs);
    }

    const out: string[] = ['#EXTM3U'];
    for (const h of parsed.headerLines) {
      out.push(h.startsWith('#EXT-X-MAP') ? rewriteUriAttr(h, rewrite) : h);
    }
    const emitFromEra = state.eraCapable === true && state.buf.length > 0;
    out.push(
      `#EXT-X-MEDIA-SEQUENCE:${emitFromEra ? state.buf[0]!.era!.label : (state.buf[0]?.virtualSeq ?? state.nextVirtual)}`,
    );
    out.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${emitFromEra ? state.buf[0]!.era!.eraIndex : state.discSeq}`);
    for (const seg of state.buf) {
      if (seg.disc) out.push('#EXT-X-DISCONTINUITY');
      out.push(...seg.tags);
      out.push(seg.uri);
    }
    if (parsed.endList) out.push('#EXT-X-ENDLIST');
    return `${out.join('\n')}\n`;
  }

  /**
   * Labels a batch of freshly-admitted segments via the era path: era
   * membership from PDT (`classifyEra`), label = rawSeq + C_v(era). C_v is
   * doc-adopted when known (rule 2), else extended at a seam from the
   * previously-labeled segment (`C_new = label(prev) + 1 - rawSeq`), else —
   * only for the very first segment this variant ever labels — seeded for
   * era 0 from the anchor's stamp (`floor(splicePdtMs/1000/segmentSeconds)`).
   *
   * `bootstrapping`: true while state.buf is still empty and era-capability
   * hasn't been decided yet — any single underivable segment aborts the
   * WHOLE batch (returns null) so the caller can cleanly fall back to legacy
   * before anything is committed. Once committed (false), an underivable
   * segment (should not happen in practice — see classifyEra) is skipped and
   * logged rather than aborting, since legacy fallback is no longer safe
   * (would mix numbering schemes in one buffer).
   */
  private labelEraBatch(
    ch: ChannelState,
    variant: string,
    state: VariantState,
    fresh: { seg: ParsedSegment; rawSeq: number }[],
    bootstrapping: boolean,
  ): { seg: ParsedSegment; rawSeq: number; eraIndex: number; label: number }[] | null {
    const out: { seg: ParsedSegment; rawSeq: number; eraIndex: number; label: number }[] = [];
    let running: EraPosition | null = state.buf.length > 0 ? state.buf[state.buf.length - 1]!.era : null;
    for (const { seg, rawSeq } of fresh) {
      const classified = this.classifySegmentEra(ch, state, seg, rawSeq, running);
      if (classified === null) {
        if (bootstrapping) return null;
        this.logger.warn(
          `channel ${ch.channel.slug}/${variant}: segment rawSeq ${rawSeq} could not be classified into a known era; skipping`,
        );
        continue;
      }
      running = classified;
      out.push({ seg, rawSeq, ...classified });
    }
    return out;
  }

  private classifySegmentEra(
    ch: ChannelState,
    state: VariantState,
    seg: ParsedSegment,
    rawSeq: number,
    running: EraPosition | null,
  ): EraPosition | null {
    if (seg.pdtMs === null) return null; // era membership needs PDT
    const pdtEndMs = seg.pdtMs + seg.durationSec * 1000;
    const eraIndex = classifyEra(ch.eras, pdtEndMs);
    if (eraIndex === null) return null;

    if (running !== null && running.eraIndex === eraIndex) {
      const c = state.chain.get(eraIndex);
      if (c === undefined) return null; // defensive: should always be set once an era is "running"
      return { eraIndex, label: rawSeq + c };
    }

    let c = state.chain.get(eraIndex);
    if (c === undefined) {
      if (running !== null) {
        // chain extension at the seam: labels stay globally consecutive
        c = running.label + 1 - rawSeq;
      } else if (eraIndex === 0) {
        const anchor0 = ch.eras.find((e) => e.eraIndex === 0);
        if (anchor0?.splicePdtMs == null) return null; // era 0 has no usable timestamp and no offsets: underivable
        c = Math.floor(anchor0.splicePdtMs / 1000 / ch.channel.segmentSeconds) - rawSeq;
      } else {
        return null; // mid-era join with no doc offset and no local seam observation
      }
      state.chain.set(eraIndex, c);
    }
    return { eraIndex, label: rawSeq + c };
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  /**
   * Background probe: checks EVERY upstream of EVERY channel (master + first
   * media playlist) so health/lag stay fresh in status for the controller —
   * which owns all failover decisions. Never switches. Driven by a
   * probeIntervalMs timer in main.ts.
   */
  async probeAll(): Promise<void> {
    for (const ch of this.channels.values()) {
      if (ch.onDemandIdle) continue; // encode is intentionally down — see the module header
      await Promise.all(ch.channel.upstreams.map((up) => this.probeUpstream(ch, up)));
    }
  }

  /**
   * Fire-and-forget probe of every upstream that has never been checked (a
   * brand-new channel, or a new upstream added to an existing one) — lets the
   * controller observe health/lag shortly after a push instead of waiting up
   * to probeIntervalMs for the next probeAll() tick. probeUpstream never
   * throws (failures become markHealth(false, …)); the catch is defensive.
   */
  private probeNeverChecked(): void {
    for (const ch of this.channels.values()) {
      if (ch.onDemandIdle) continue; // encode is intentionally down — see the module header
      for (const up of ch.channel.upstreams) {
        if (ch.health.get(up.id)?.checkedAt === null) {
          void this.probeUpstream(ch, up).catch(() => undefined);
        }
      }
    }
  }

  private async probeUpstream(ch: ChannelState, up: SwitcherUpstream): Promise<void> {
    const master = await this.cachedFetch(up, 'playlist.m3u8');
    if (!master.ok) {
      this.markHealth(ch, up.id, false, null, master.error ?? `HTTP ${master.status}`);
      return;
    }
    const { variants } = rewriteMasterPlaylist(master.text, up.url);
    for (const v of variants) ch.knownVariants.add(v);
    const variant = variants[0] ?? [...ch.knownVariants][0];
    if (variant === undefined) {
      this.markHealth(ch, up.id, true, null);
      return;
    }
    const media = await this.cachedFetch(up, `${variant}/stream.m3u8`);
    if (!media.ok) {
      this.markHealth(ch, up.id, false, null, media.error ?? `HTTP ${media.status}`);
      return;
    }
    const parsed = parseMediaPlaylist(media.text);
    const lagSec = parsed.lastPdtEndMs !== null ? Math.max(0, (this.now() - parsed.lastPdtEndMs) / 1000) : null;
    const stale = lagSec !== null && lagSec > this.staleThresholdSec(ch);
    this.markHealth(ch, up.id, !stale, lagSec, stale ? `stale playlist (lag ${lagSec?.toFixed(1)}s)` : undefined);
  }

  private staleThresholdSec(ch: ChannelState): number {
    return 3 * ch.channel.segmentSeconds + this.stallGraceSec;
  }

  private markHealth(
    ch: ChannelState,
    upstreamId: string,
    healthy: boolean,
    lagSec: number | null,
    error?: string,
  ): void {
    const prev = ch.health.get(upstreamId);
    const entry: UpstreamHealth = { healthy, checkedAt: this.now() };
    const lag = lagSec ?? prev?.playlistLagSec;
    if (lag !== undefined) entry.playlistLagSec = lag;
    if (error !== undefined) entry.lastError = error;
    if (prev !== undefined && prev.checkedAt !== null && prev.healthy !== healthy) {
      this.logger.warn(
        `channel ${ch.channel.slug}: upstream ${upstreamId} is now ${healthy ? 'healthy' : `unhealthy (${error ?? 'unknown'})`}`,
      );
    }
    ch.health.set(upstreamId, entry);
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  channelStatuses(): SwitcherChannelStatus[] {
    return [...this.channels.values()].map((ch) => {
      const status: SwitcherChannelStatus = {
        slug: ch.channel.slug,
        activeUpstreamId: ch.activeUpstreamId,
        upstreams: ch.channel.upstreams.map((up) => {
          const h = ch.health.get(up.id);
          const entry: { id: string; healthy: boolean; playlistLagSec?: number } = {
            id: up.id,
            healthy: h?.healthy ?? true,
          };
          if (h?.playlistLagSec !== undefined) entry.playlistLagSec = h.playlistLagSec;
          return entry;
        }),
        lastSwitch: ch.lastSwitch,
      };
      // report chain-derived C_v only (provenance rule 1) — fallback-seeded
      // variants never populate `chain` at all, so any non-empty chain here is
      // safe to report as-is.
      const eraOffsets: Record<string, Record<string, number>> = {};
      for (const [variantName, vstate] of ch.variants) {
        if (vstate.eraCapable !== true || vstate.chain.size === 0) continue;
        const perEra: Record<string, number> = {};
        for (const [eraIdx, c] of vstate.chain) perEra[String(eraIdx)] = c;
        eraOffsets[variantName] = perEra;
      }
      if (Object.keys(eraOffsets).length > 0) status.eraOffsets = eraOffsets;
      return status;
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireChannel(slug: string): ChannelState {
    const ch = this.channels.get(slug);
    if (!ch) throw new UnknownChannelError(`unknown channel ${slug}`);
    return ch;
  }

  private activeUpstream(ch: ChannelState): SwitcherUpstream {
    const found = ch.channel.upstreams.find((u) => u.id === ch.activeUpstreamId);
    if (found) return found;
    // defensive — applyDesired always selects an existing upstream
    const sorted = [...ch.channel.upstreams].sort((a, b) => a.priority - b.priority);
    return sorted[0] as SwitcherUpstream;
  }

  /** micro-cache: one upstream fetch per (url) per cacheTtlMs, results (incl. failures) shared by all viewers */
  private async cachedFetch(up: SwitcherUpstream, path: string): Promise<CacheEntry> {
    const url = `${trimSlash(up.url)}/${path}`;
    const now = this.now();
    const hit = this.cache.get(url);
    if (hit && now - hit.at < this.cacheTtlMs) return hit;
    let entry: CacheEntry;
    try {
      const res = await this.fetchImpl(url);
      const text = await res.text();
      entry = { at: now, ok: res.ok, status: res.status, text };
    } catch (err) {
      entry = { at: now, ok: false, status: 0, text: '', error: err instanceof Error ? err.message : String(err) };
    }
    this.cache.set(url, entry);
    return entry;
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** resolves after ms, or immediately once `signal` aborts — used by waitServeable's poll loop */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
