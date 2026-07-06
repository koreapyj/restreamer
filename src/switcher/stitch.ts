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
 *   - master:  variant/rendition URIs rewritten to the switcher's own routes
 *              (`/hls/<slug>/<variant>/stream.m3u8`),
 *   - media:   segment / EXT-X-MAP URIs rewritten to ABSOLUTE upstream URLs
 *              (segments flow node→viewer directly; the switcher serves only
 *              small text), MEDIA-SEQUENCE / DISCONTINUITY-SEQUENCE replaced
 *              by virtual values, and an EXT-X-DISCONTINUITY spliced in at
 *              switch points.
 *
 * ── Virtual MEDIA-SEQUENCE (monotonic across switches AND restarts) ────────
 *
 * Per (channel, variant) we keep an anchor { upstreamId, anchorFirstRaw,
 * anchorVirtual }:
 *
 *   timeBase(now) = floor(nowMs / 1000 / segmentSeconds)      (epoch base 0)
 *
 *   firstServedRaw = upstream MEDIA-SEQUENCE + dropCount
 *     (dropCount = leading segments removed by the PDT splice, see below —
 *      the raw index of the first segment we actually serve)
 *
 *   - First render ever for a variant (fresh process / new channel):
 *       anchorVirtual = timeBase(now); no discontinuity.
 *   - First render after a switch (anchor.upstreamId ≠ active):
 *       anchorVirtual = max(timeBase(now), lastServedVirtual + 1)
 *       and the splice discontinuity is attached to firstServedRaw.
 *   - Every render:
 *       virtual = anchorVirtual + max(0, firstServedRaw − anchorFirstRaw)
 *
 * Why this never decreases:
 *   - Within one upstream, firstServedRaw is non-decreasing: when the window
 *     slides over a spliced-out (dropped) segment, raw +1 / drops −1 (sum
 *     unchanged); when it slides over a served segment, raw +1 (sum +1).
 *     The max(0, …) clamp absorbs a raw-sequence regression (encoder
 *     restart) — virtual holds instead of stepping back.
 *   - Across a switch, max(timeBase, last+1) is ≥ everything served before,
 *     even when the new upstream's raw sequence is LOWER than the old one's
 *     (the anchor is re-based, raw values never leak into the tag).
 *   - Across a switcher restart, the fresh anchor is timeBase(now). Real-time
 *     encoders slide ≤ 1 segment per segmentSeconds of wall clock, so the
 *     previous instance's virtual value tracked timeBase within ~1 segment of
 *     jitter — and a restart takes longer than that, so the new base lands at
 *     or ahead of anything previously served.
 *
 * ── Virtual DISCONTINUITY-SEQUENCE ──────────────────────────────────────────
 *
 *   served = discBase + upstream EXT-X-DISCONTINUITY-SEQUENCE (0 if absent)
 *
 * Upstream discontinuities (encoder restarts, discont_start) pass through
 * both as tags and in the sequence. Our splice tag is attached to the raw
 * index of the first post-switch segment: at re-anchor discBase is chosen so
 * the served value is CONTINUOUS with what clients already saw; when the
 * carrying segment slides out of the window the tag disappears and discBase
 * is bumped by one — exactly the RFC 8216 rule for a discontinuity leaving
 * the playlist.
 *
 * ── PDT-aligned splice ──────────────────────────────────────────────────────
 *
 * doSwitch() records the channel-level splice point: the PROGRAM-DATE-TIME
 * end (pdt + duration) of the last segment served to anyone before the
 * switch. Both encoders stamp true wall clock, so on the next render of each
 * variant, leading new-upstream segments whose pdt + duration ≤ splicePoint
 * are dropped — the viewer continues (nearly) exactly where the old upstream
 * left off, with minimal overlap. No PDT ⇒ no drops (plain live-window
 * switch). All variants share the one channel-level switch decision and
 * splice point; each applies it independently on its next render.
 *
 * ── Health + autonomous failover ────────────────────────────────────────────
 *
 * An upstream is unhealthy when a playlist fetch fails (non-2xx / network
 * error) or its media playlist's last PDT lags wall clock by more than
 * 3 × segmentSeconds + stallGraceSec. Health is (re)evaluated on every
 * on-demand fetch of the ACTIVE upstream; probeAll() (driven by a timer in
 * main.ts) checks every upstream of every channel so unwatched channels fail
 * over too and failover targets are known-healthy. Never-probed upstreams
 * are treated optimistically healthy so first-failure failover can proceed.
 * When the active upstream goes unhealthy the channel switches to the
 * highest-priority healthy upstream (reason 'failover'); with no healthy
 * candidate it stays put — a stale-but-fetchable playlist is still served,
 * a failed fetch surfaces as UpstreamUnavailableError (HTTP 503 upstairs).
 *
 * Pure-ish: fetch and clock are injected; no filesystem access (persistence
 * is the caller's job via onSelectionsChanged / getSelections()).
 */

import type {
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

export interface SwitchSelection {
  upstreamId: string;
  /** ISO 8601 */
  switchedAt: string;
  reason: SwitchReason;
}
export type SelectionMap = Record<string, SwitchSelection>;

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

interface RenderMediaOpts {
  virtualSeq: number;
  virtualDiscSeq: number;
  /** leading segments removed by the PDT splice */
  drop: number;
  /** index into the KEPT segments before which the splice EXT-X-DISCONTINUITY goes; -1 = none */
  discIndex: number;
  /** absolute upstream base for this variant: `<upstream url>/<variant>` */
  base: string;
}

function renderMediaPlaylist(p: ParsedMedia, o: RenderMediaOpts): string {
  const abs = (uri: string) => (isAbsoluteUri(uri) ? uri : `${o.base}/${uri}`);
  const out: string[] = ['#EXTM3U'];
  for (const h of p.headerLines) {
    out.push(h.startsWith('#EXT-X-MAP') ? rewriteUriAttr(h, abs) : h);
  }
  out.push(`#EXT-X-MEDIA-SEQUENCE:${o.virtualSeq}`);
  out.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${o.virtualDiscSeq}`);
  p.segments.slice(o.drop).forEach((seg, i) => {
    if (i === o.discIndex) out.push('#EXT-X-DISCONTINUITY');
    out.push(...seg.tags);
    out.push(abs(seg.uri));
  });
  if (p.endList) out.push('#EXT-X-ENDLIST');
  return `${out.join('\n')}\n`;
}

/**
 * Rewrites a master playlist: relative `<variant>/stream.m3u8` URIs (variant
 * playlists AND audio/subtitle rendition URI attributes) become the
 * switcher's own routes; other relative URIs are absolutized against the
 * upstream; absolute URIs and every non-URI line pass through verbatim.
 */
export function rewriteMasterPlaylist(
  text: string,
  slug: string,
  upstreamUrl: string,
): { text: string; variants: string[] } {
  const variants: string[] = [];
  const rewrite = (uri: string): string => {
    if (isAbsoluteUri(uri)) return uri;
    const m = /^(.+)\/stream\.m3u8$/.exec(uri);
    if (m?.[1]) {
      variants.push(m[1]);
      return `/hls/${slug}/${m[1]}/stream.m3u8`;
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

interface VariantState {
  /** upstream the anchor belongs to; a mismatch with the active id ⇒ first render after a switch */
  upstreamId: string;
  anchorFirstRaw: number;
  anchorVirtual: number;
  /** virtual DISCONTINUITY-SEQUENCE = discBase + upstream raw value */
  discBase: number;
  /** raw index (new-upstream numbering) of the segment carrying the splice discontinuity; null = none pending */
  discTagRaw: number | null;
  /** PDT splice point consumed by this anchor (drop rule), copied from the channel at re-anchor */
  spliceFromPdtMs: number | null;
  lastVirtual: number;
  lastDiscSeq: number;
}

interface ChannelState {
  channel: SwitcherChannel;
  activeUpstreamId: string | null;
  lastSwitch: { at: string; from: string | null; to: string; reason: SwitchReason } | null;
  /** channel-level pending splice point, set by doSwitch() */
  spliceFromPdtMs: number | null;
  /** PDT end of the newest segment ever served for this channel (any variant) */
  lastServedPdtEndMs: number | null;
  knownVariants: Set<string>;
  health: Map<string, UpstreamHealth>;
  variants: Map<string, VariantState>;
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
  /** persistence hook — fired after any change to the active-selection map */
  onSelectionsChanged?: () => void;
}

const NULL_LOGGER: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export class Stitcher {
  private readonly cacheTtlMs: number;
  private readonly stallGraceSec: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly onSelectionsChanged: () => void;

  private channels = new Map<string, ChannelState>();
  private selections: SelectionMap = {};
  private desired: SwitcherDesiredState | null = null;
  private cache = new Map<string, CacheEntry>();

  constructor(opts: StitcherOptions) {
    this.cacheTtlMs = opts.cacheTtlMs;
    this.stallGraceSec = opts.stallGraceSec;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger ?? NULL_LOGGER;
    this.onSelectionsChanged = opts.onSelectionsChanged ?? (() => {});
  }

  get desiredRevision(): string | null {
    return this.desired?.revision ?? null;
  }

  getDesired(): SwitcherDesiredState | null {
    return this.desired;
  }

  getSelections(): SelectionMap {
    return { ...this.selections };
  }

  // -------------------------------------------------------------------------
  // Desired state
  // -------------------------------------------------------------------------

  /**
   * Full replace. Selection policy:
   *   - `initialSelections` (restart restore) wins when its upstream still
   *     exists for the slug;
   *   - else the current in-memory selection is kept if its upstream survived;
   *   - else (selection's upstream removed) the highest-priority healthy
   *     upstream — or the highest-priority one — is picked, reason 'push';
   *   - brand-new channels pick the priority-1 (lowest number) upstream;
   *   - removed channels are dropped, selections pruned.
   */
  applyDesired(doc: SwitcherDesiredState, initialSelections?: SelectionMap): void {
    const next = new Map<string, ChannelState>();
    const nextSelections: SelectionMap = {};

    for (const channel of doc.channels) {
      const prev = this.channels.get(channel.slug);
      const st: ChannelState = prev ?? {
        channel,
        activeUpstreamId: null,
        lastSwitch: null,
        spliceFromPdtMs: null,
        lastServedPdtEndMs: null,
        knownVariants: new Set(),
        health: new Map(),
        variants: new Map(),
      };
      st.channel = channel;

      const ids = new Set(channel.upstreams.map((u) => u.id));
      const health = new Map<string, UpstreamHealth>();
      for (const up of channel.upstreams) {
        health.set(up.id, st.health.get(up.id) ?? { healthy: true, checkedAt: null });
      }
      st.health = health;

      const restored = initialSelections?.[channel.slug];
      if (restored && ids.has(restored.upstreamId)) {
        st.activeUpstreamId = restored.upstreamId;
        // reconstruct lastSwitch from the persisted selection (from is unknown across restarts)
        st.lastSwitch = { at: restored.switchedAt, from: null, to: restored.upstreamId, reason: restored.reason };
        nextSelections[channel.slug] = restored;
      } else if (st.activeUpstreamId !== null && ids.has(st.activeUpstreamId)) {
        // active upstream survived the push — keep serving it untouched
        const kept = this.selections[channel.slug];
        nextSelections[channel.slug] = kept ?? {
          upstreamId: st.activeUpstreamId,
          switchedAt: new Date(this.now()).toISOString(),
          reason: 'push',
        };
      } else {
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
          st.spliceFromPdtMs = st.lastServedPdtEndMs;
        }
        st.activeUpstreamId = healthyFirst.id;
        nextSelections[channel.slug] = {
          upstreamId: healthyFirst.id,
          switchedAt: new Date(this.now()).toISOString(),
          reason: 'push',
        };
      }
      next.set(channel.slug, st);
    }

    this.channels = next;
    this.selections = nextSelections;
    this.desired = doc;
    this.cache.clear();
    this.onSelectionsChanged();
  }

  // -------------------------------------------------------------------------
  // Switching
  // -------------------------------------------------------------------------

  /** Manual/API switch. Throws UnknownChannelError / UnknownUpstreamError; no-op when already active. */
  switchTo(slug: string, upstreamId: string, reason: SwitchReason): void {
    const ch = this.requireChannel(slug);
    if (!ch.channel.upstreams.some((u) => u.id === upstreamId)) {
      throw new UnknownUpstreamError(`unknown upstream ${upstreamId} for channel ${slug}`);
    }
    if (ch.activeUpstreamId === upstreamId) return;
    this.doSwitch(ch, upstreamId, reason);
  }

  private doSwitch(ch: ChannelState, toId: string, reason: SwitchReason): void {
    const from = ch.activeUpstreamId;
    const at = new Date(this.now()).toISOString();
    ch.activeUpstreamId = toId;
    ch.lastSwitch = { at, from, to: toId, reason };
    // PDT-aligned splice point: everything served so far ends here
    ch.spliceFromPdtMs = ch.lastServedPdtEndMs;
    this.selections[ch.channel.slug] = { upstreamId: toId, switchedAt: at, reason };
    this.logger.info(`channel ${ch.channel.slug}: switched ${from ?? '(none)'} → ${toId} (${reason})`);
    this.onSelectionsChanged();
  }

  // -------------------------------------------------------------------------
  // Playlist serving
  // -------------------------------------------------------------------------

  async getMasterPlaylist(slug: string): Promise<string> {
    const ch = this.requireChannel(slug);
    const tried = new Set<string>();
    for (;;) {
      const upstream = this.activeUpstream(ch);
      const res = await this.cachedFetch(upstream, 'playlist.m3u8');
      if (res.ok) {
        // master has no PDT — fetch success alone marks reachable; preserve any known lag
        this.markHealth(ch, upstream.id, true, ch.health.get(upstream.id)?.playlistLagSec ?? null);
        const { text, variants } = rewriteMasterPlaylist(res.text, slug, upstream.url);
        for (const v of variants) ch.knownVariants.add(v);
        return text;
      }
      this.markHealth(ch, upstream.id, false, null, res.error ?? `HTTP ${res.status}`);
      tried.add(upstream.id);
      const candidate = this.pickCandidate(ch, tried);
      if (!candidate) {
        throw new UpstreamUnavailableError(
          `channel ${slug}: no healthy upstream (active ${upstream.id}: ${res.error ?? `HTTP ${res.status}`})`,
          Math.ceil(ch.channel.segmentSeconds),
        );
      }
      this.doSwitch(ch, candidate.id, 'failover');
    }
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
    const tried = new Set<string>();
    for (;;) {
      const upstream = this.activeUpstream(ch);
      const res = await this.cachedFetch(upstream, `${variant}/stream.m3u8`);
      if (res.ok) {
        const parsed = parseMediaPlaylist(res.text);
        const lagSec = parsed.lastPdtEndMs !== null ? Math.max(0, (this.now() - parsed.lastPdtEndMs) / 1000) : null;
        const stale = lagSec !== null && lagSec > this.staleThresholdSec(ch);
        if (!stale) {
          this.markHealth(ch, upstream.id, true, lagSec);
          return this.renderForVariant(ch, variant, upstream, parsed);
        }
        this.markHealth(ch, upstream.id, false, lagSec, `stale playlist (lag ${lagSec.toFixed(1)}s)`);
        tried.add(upstream.id);
        const candidate = this.pickCandidate(ch, tried);
        if (!candidate) {
          // no healthy alternative — stay on the stale upstream and keep serving its content
          return this.renderForVariant(ch, variant, upstream, parsed);
        }
        this.doSwitch(ch, candidate.id, 'failover');
        continue;
      }
      this.markHealth(ch, upstream.id, false, null, res.error ?? `HTTP ${res.status}`);
      tried.add(upstream.id);
      const candidate = this.pickCandidate(ch, tried);
      if (!candidate) {
        throw new UpstreamUnavailableError(
          `channel ${slug}/${variant}: no healthy upstream (active ${upstream.id}: ${res.error ?? `HTTP ${res.status}`})`,
          Math.ceil(ch.channel.segmentSeconds),
        );
      }
      this.doSwitch(ch, candidate.id, 'failover');
    }
  }

  /**
   * Applies the per-variant virtual sequencing + splice documented at the top
   * of this file to a freshly parsed upstream playlist.
   */
  private renderForVariant(
    ch: ChannelState,
    variant: string,
    upstream: SwitcherUpstream,
    parsed: ParsedMedia,
  ): string {
    const nowMs = this.now();
    let vs = ch.variants.get(variant);
    const reanchor = !vs || vs.upstreamId !== upstream.id;
    const spliceAt = reanchor ? ch.spliceFromPdtMs : (vs?.spliceFromPdtMs ?? null);

    // PDT splice: drop leading segments that end at or before the splice
    // point — but never the whole window (always keep the newest segment).
    let drop = 0;
    if (spliceAt !== null) {
      for (const seg of parsed.segments) {
        if (seg.pdtMs !== null && seg.pdtMs + seg.durationSec * 1000 <= spliceAt) drop += 1;
        else break;
      }
      if (parsed.segments.length > 0 && drop >= parsed.segments.length) drop = parsed.segments.length - 1;
    }

    const firstRaw = parsed.mediaSequence + drop;
    const timeBase = Math.floor(nowMs / 1000 / ch.channel.segmentSeconds);

    if (reanchor) {
      const firstEver = vs === undefined;
      const anchorVirtual = firstEver ? timeBase : Math.max(timeBase, (vs as VariantState).lastVirtual + 1);
      vs = {
        upstreamId: upstream.id,
        anchorFirstRaw: firstRaw,
        anchorVirtual,
        // keep the served DISCONTINUITY-SEQUENCE continuous across the switch
        discBase: firstEver ? 0 : (vs as VariantState).lastDiscSeq - parsed.discontinuitySequence,
        // the splice discontinuity rides on the first post-switch segment
        discTagRaw: firstEver ? null : firstRaw,
        spliceFromPdtMs: spliceAt,
        lastVirtual: anchorVirtual,
        lastDiscSeq: firstEver ? parsed.discontinuitySequence : (vs as VariantState).lastDiscSeq,
      };
      ch.variants.set(variant, vs);
    }
    const state = vs as VariantState;

    // our splice tag slid out of the upstream window → RFC 8216: sequence +1
    if (state.discTagRaw !== null && state.discTagRaw < firstRaw) {
      state.discTagRaw = null;
      state.discBase += 1;
    }

    const virtualSeq = state.anchorVirtual + Math.max(0, firstRaw - state.anchorFirstRaw);
    const virtualDiscSeq = state.discBase + parsed.discontinuitySequence;
    state.lastVirtual = virtualSeq;
    state.lastDiscSeq = virtualDiscSeq;

    let discIndex = -1;
    if (state.discTagRaw !== null) {
      const idx = state.discTagRaw - firstRaw;
      if (idx >= 0 && idx < parsed.segments.length - drop) discIndex = idx;
    }

    if (parsed.lastPdtEndMs !== null) {
      ch.lastServedPdtEndMs = Math.max(ch.lastServedPdtEndMs ?? 0, parsed.lastPdtEndMs);
    }

    return renderMediaPlaylist(parsed, {
      virtualSeq,
      virtualDiscSeq,
      drop,
      discIndex,
      base: `${trimSlash(upstream.url)}/${variant}`,
    });
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  /**
   * Background probe: checks EVERY upstream of EVERY channel (master + first
   * media playlist) so health stays fresh for unwatched channels, and fails
   * over any channel whose active upstream is unhealthy while a healthy
   * candidate exists. Driven by a probeIntervalMs timer in main.ts.
   */
  async probeAll(): Promise<void> {
    for (const ch of this.channels.values()) {
      await Promise.all(ch.channel.upstreams.map((up) => this.probeUpstream(ch, up)));
      const active = ch.activeUpstreamId !== null ? ch.health.get(ch.activeUpstreamId) : undefined;
      if (ch.activeUpstreamId !== null && active && !active.healthy) {
        const candidate = this.pickCandidate(ch, new Set([ch.activeUpstreamId]));
        if (candidate) this.doSwitch(ch, candidate.id, 'failover');
      }
    }
  }

  private async probeUpstream(ch: ChannelState, up: SwitcherUpstream): Promise<void> {
    const master = await this.cachedFetch(up, 'playlist.m3u8');
    if (!master.ok) {
      this.markHealth(ch, up.id, false, null, master.error ?? `HTTP ${master.status}`);
      return;
    }
    const { variants } = rewriteMasterPlaylist(master.text, ch.channel.slug, up.url);
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

  /** highest-priority upstream that is not excluded, not active, and not known-unhealthy */
  private pickCandidate(ch: ChannelState, exclude: Set<string>): SwitcherUpstream | null {
    const sorted = [...ch.channel.upstreams].sort((a, b) => a.priority - b.priority);
    for (const up of sorted) {
      if (up.id === ch.activeUpstreamId || exclude.has(up.id)) continue;
      if (ch.health.get(up.id)?.healthy === false) continue;
      return up;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  channelStatuses(): SwitcherChannelStatus[] {
    return [...this.channels.values()].map((ch) => ({
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
    }));
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
