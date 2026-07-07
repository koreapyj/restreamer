/*
 * Shared fixtures for the switcher tests: realistic upstream playlists
 * mirroring the production arib-hls output (var_stream_map → variants
 * 1080p / arib_1 / arib_2 / arib_ass, media playlists named
 * `<variant>/stream.m3u8` with PROGRAM-DATE-TIME tags, EXTINF 5.0 and
 * strftime-style segment names), plus an injectable fake fetch.
 */

import type { SwitcherDesiredState } from '../../src/contract/v1.js';

/** aligned to the 5s segment grid (divisible by 5000ms) */
export const T0 = Date.UTC(2026, 0, 1);

export const NODE_A = 'http://node-a/media/ch1';
export const NODE_B = 'http://node-b/media/ch1';

export const VARIANTS = ['1080p', 'arib_1', 'arib_2', 'arib_ass'] as const;

export function desiredDoc(revision = 'rev-1'): SwitcherDesiredState {
  return {
    apiVersion: 1,
    revision,
    channels: [
      {
        slug: 'ch1',
        segmentSeconds: 5,
        upstreams: [
          { id: 'p-a', url: NODE_A, priority: 1 },
          { id: 'p-b', url: NODE_B, priority: 2 },
        ],
      },
    ],
  };
}

/** master playlist as produced by the prod var_stream_map (1080p video + 2 audio renditions + subtitle rendition) */
export function masterPlaylist(): string {
  return `${[
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="arib_1",DEFAULT=YES,LANGUAGE="ja",URI="arib_1/stream.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="arib_2",DEFAULT=NO,LANGUAGE="en",URI="arib_2/stream.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="arib",NAME="arib_ass",DEFAULT=NO,LANGUAGE="ja",URI="arib_ass/stream.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=3500000,CODECS="hvc1.1.6.L123.B0,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="audio",SUBTITLES="arib"',
    '1080p/stream.m3u8',
  ].join('\n')}\n`;
}

/** strftime `%Y%m%d-%H%M%S.ts` (UTC), like `-hls_segment_filename` in prod */
export function segName(pdtMs: number): string {
  const d = new Date(pdtMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.ts`
  );
}

export interface MediaOpts {
  mediaSeq: number;
  discSeq?: number;
  firstPdtMs: number;
  count?: number;
  segSec?: number;
  /** EXT-X-MAP URI (relative) */
  map?: string;
}

export function mediaPlaylist(o: MediaOpts): string {
  const segSec = o.segSec ?? 5;
  const count = o.count ?? 6;
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(segSec)}`,
    `#EXT-X-MEDIA-SEQUENCE:${o.mediaSeq}`,
  ];
  if (o.discSeq !== undefined) lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${o.discSeq}`);
  if (o.map !== undefined) lines.push(`#EXT-X-MAP:URI="${o.map}"`);
  for (let i = 0; i < count; i += 1) {
    const pdt = o.firstPdtMs + i * segSec * 1000;
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(pdt).toISOString()}`);
    lines.push(`#EXTINF:${segSec.toFixed(6)},`);
    lines.push(segName(pdt));
  }
  return `${lines.join('\n')}\n`;
}

export interface LiveOpts {
  segSec?: number;
  window?: number;
  /** added to the natural raw MEDIA-SEQUENCE (use a large negative value to simulate a low-sequence upstream) */
  seqOffset?: number;
  /** upstream frozen this many seconds behind wall clock (stall simulation) */
  staleSec?: number;
  discSeq?: number;
}

/**
 * A "live" media playlist whose window tracks the given wall clock: the
 * newest segment is the last fully written one, PDTs are on the epoch-aligned
 * segment grid.
 */
export function liveMediaText(nowMs: number, opts: LiveOpts = {}): string {
  const segSec = opts.segSec ?? 5;
  const segMs = segSec * 1000;
  const window = opts.window ?? 6;
  const t = nowMs - (opts.staleSec ?? 0) * 1000;
  const newestK = Math.floor(t / segMs) - 1;
  const firstK = newestK - window + 1;
  return mediaPlaylist({
    mediaSeq: firstK + (opts.seqOffset ?? 0),
    discSeq: opts.discSeq,
    firstPdtMs: firstK * segMs,
    count: window,
    segSec,
  });
}

export type RouteHandler = () => string | { status: number; body?: string } | Error;

export interface FakeNet {
  routes: Record<string, RouteHandler>;
  calls: string[];
  fetchImpl: typeof fetch;
}

/** injectable fetch over a mutable URL → handler map; unknown URLs get a 404 */
export function makeFetch(routes: Record<string, RouteHandler> = {}): FakeNet {
  const calls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const handler = routes[url];
    if (!handler) return new Response('not found', { status: 404 });
    const result = handler();
    if (result instanceof Error) throw result;
    if (typeof result === 'string') return new Response(result, { status: 200 });
    return new Response(result.body ?? '', { status: result.status });
  }) as typeof fetch;
  return { routes, calls, fetchImpl };
}

/**
 * Registers a full live upstream (master + all four variant playlists) whose
 * window follows `clock.nowMs`. Mutate `opts` (e.g. `opts.staleSec = 60`)
 * to change behavior mid-test.
 */
export function liveUpstream(net: FakeNet, base: string, clock: { nowMs: number }, opts: LiveOpts = {}): LiveOpts {
  net.routes[`${base}/playlist.m3u8`] = () => masterPlaylist();
  for (const v of VARIANTS) {
    net.routes[`${base}/${v}/stream.m3u8`] = () => liveMediaText(clock.nowMs, opts);
  }
  return opts;
}

export const seqOf = (text: string): number => {
  const m = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text);
  if (!m?.[1]) throw new Error(`no MEDIA-SEQUENCE in:\n${text}`);
  return Number(m[1]);
};

export const discSeqOf = (text: string): number => {
  const m = /#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/.exec(text);
  if (!m?.[1]) throw new Error(`no DISCONTINUITY-SEQUENCE in:\n${text}`);
  return Number(m[1]);
};

export const discCount = (text: string): number => (text.match(/^#EXT-X-DISCONTINUITY$/gm) ?? []).length;

export const pdtsOf = (text: string): number[] =>
  [...text.matchAll(/#EXT-X-PROGRAM-DATE-TIME:(\S+)/g)].map((m) => Date.parse(m[1] as string));

export const segmentUrisOf = (text: string): string[] =>
  text.split('\n').filter((l) => l !== '' && !l.startsWith('#'));

/** count of served segment URIs baked with the given upstream id (redirect mode) */
export const countFor = (text: string, upstreamId: string): number =>
  segmentUrisOf(text).filter((u) => u.startsWith(`seg/${upstreamId}/`)).length;

/** each segment URI paired with its preceding PROGRAM-DATE-TIME (NaN if none) */
export const segEntries = (text: string): { pdt: number; uri: string }[] => {
  const out: { pdt: number; uri: string }[] = [];
  let pdt = Number.NaN;
  for (const line of text.split('\n')) {
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      pdt = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
    } else if (line !== '' && !line.startsWith('#')) {
      out.push({ pdt, uri: line });
      pdt = Number.NaN;
    }
  }
  return out;
};
