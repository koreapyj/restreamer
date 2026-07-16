/*
 * Splice-core tests: URL rewriting, virtual MEDIA-SEQUENCE monotonicity
 * (window slide / low-sequence switch / restart), discontinuity bookkeeping,
 * PDT-aligned splice, health probing (no autonomous failover — the controller
 * owns all switches), applyDesired selection rules and the fetch micro-cache.
 * Injected fetch + fake clock throughout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Stitcher,
  UnknownChannelError,
  UnknownUpstreamError,
  UpstreamUnavailableError,
} from '../../src/switcher/stitch.js';
import {
  NODE_A,
  NODE_B,
  T0,
  countFor,
  desiredDoc,
  discCount,
  discSeqOf,
  liveUpstream,
  makeFetch,
  mediaPlaylist,
  segEntries,
  segName,
  segPrefix,
  segmentUrisOf,
  seqOf,
  type LiveOpts,
} from './fixtures.js';

/** virtual sequence base for segmentSeconds=5 */
const timeBase = (ms: number) => Math.floor(ms / 1000 / 5);

function setup(opts: { aOpts?: LiveOpts; bOpts?: LiveOpts } = {}) {
  const clock = { nowMs: T0 + 1000 };
  const net = makeFetch();
  const aOpts = liveUpstream(net, NODE_A, clock, opts.aOpts ?? {});
  const bOpts = liveUpstream(net, NODE_B, clock, opts.bOpts ?? {});
  const stitcher = new Stitcher({
    cacheTtlMs: 2000,
    stallGraceSec: 10,
    fetchImpl: net.fetchImpl,
    now: () => clock.nowMs,
  });
  stitcher.applyDesired(desiredDoc());
  return { clock, net, stitcher, aOpts, bOpts };
}

describe('master playlist rewriting', () => {
  it('keeps variant and audio/subtitle rendition URIs relative, the rest verbatim', async () => {
    const { stitcher } = setup();
    const text = await stitcher.getMasterPlaylist('ch1');
    expect(text).toContain('\n1080p/stream.m3u8');
    expect(text).toContain('URI="arib_1/stream.m3u8"');
    expect(text).toContain('URI="arib_2/stream.m3u8"');
    expect(text).toContain('URI="arib_ass/stream.m3u8"');
    // relative to the master's own URL: no host, no leading slash, no /hls prefix
    expect(text).not.toContain('/hls/');
    expect(text).not.toMatch(/^\//m);
    expect(text).not.toMatch(/URI="\//);
    // attribute lists untouched apart from URI
    expect(text).toContain('TYPE=AUDIO,GROUP-ID="audio",NAME="arib_1",DEFAULT=YES,LANGUAGE="ja"');
    expect(text).toContain(
      '#EXT-X-STREAM-INF:BANDWIDTH=3500000,CODECS="hvc1.1.6.L123.B0,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="audio",SUBTITLES="arib"',
    );
    expect(text).not.toContain('node-a');
  });

  it('rejects unknown slugs', async () => {
    const { stitcher } = setup();
    await expect(stitcher.getMasterPlaylist('nope')).rejects.toBeInstanceOf(UnknownChannelError);
  });
});

describe('media playlist rewriting', () => {
  it('absolutizes segment and EXT-X-MAP URIs against the upstream and passes PDT/EXTINF/TARGETDURATION through', async () => {
    const { stitcher, net, clock } = setup();
    const firstPdt = T0 - 30_000;
    net.routes[`${NODE_A}/1080p/stream.m3u8`] = () =>
      mediaPlaylist({ mediaSeq: 100, firstPdtMs: firstPdt, count: 6, map: 'init.mp4' });
    const text = await stitcher.getMediaPlaylist('ch1', '1080p');
    expect(text).toContain(`#EXT-X-MAP:URI="${NODE_A}/1080p/init.mp4"`);
    expect(segmentUrisOf(text)).toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => `${NODE_A}/1080p/${segName(firstPdt + i * 5000)}`),
    );
    expect(text).toContain('#EXT-X-TARGETDURATION:5');
    expect(text).toContain('#EXTINF:5.000000,');
    expect(text).toContain(`#EXT-X-PROGRAM-DATE-TIME:${new Date(firstPdt).toISOString()}`);
    // raw sequence 100 replaced by the time-derived virtual sequence
    expect(seqOf(text)).toBe(timeBase(clock.nowMs));
    expect(discSeqOf(text)).toBe(0);
  });

  it('retains the outgoing-upstream tail across a switch, then fully drains to the new id', async () => {
    const { stitcher, clock } = setup();
    const before = await stitcher.getMediaPlaylist('ch1', '1080p');
    // a viewer caching this playlist can still resolve every segment via p-a
    expect(segmentUrisOf(before).every((u) => u.startsWith(segPrefix(NODE_A)))).toBe(true);

    stitcher.switchTo('ch1', 'p-b', 'manual');
    clock.nowMs = T0 + 7000;
    const after = await stitcher.getMediaPlaylist('ch1', '1080p');
    // the window did NOT collapse: the p-a tail is retained ahead of the new p-b head
    expect(countFor(after, NODE_A)).toBeGreaterThan(0);
    expect(segmentUrisOf(after).at(-1)).toContain(segPrefix(NODE_B));

    // after ~one window of new segments the retained tail has drained out
    clock.nowMs = T0 + 45_000;
    const drained = await stitcher.getMediaPlaylist('ch1', '1080p');
    expect(segmentUrisOf(drained).length).toBeGreaterThan(0);
    expect(segmentUrisOf(drained).every((u) => u.startsWith(segPrefix(NODE_B)))).toBe(true);
  });
});

describe('virtual MEDIA-SEQUENCE', () => {
  it('advances exactly with the upstream window slide', async () => {
    const { stitcher, clock } = setup();
    const v1 = seqOf(await stitcher.getMediaPlaylist('ch1', '1080p'));
    expect(v1).toBe(timeBase(clock.nowMs));
    clock.nowMs += 15_000; // window slides by 3 segments
    const v2 = seqOf(await stitcher.getMediaPlaylist('ch1', '1080p'));
    expect(v2 - v1).toBe(3);
  });

  it('stays monotonic when switching to an upstream with a much lower raw sequence', async () => {
    // node B's raw MEDIA-SEQUENCE is tiny (~100) while A's is time-derived (~3.5e8)
    const { stitcher, clock } = setup({ bOpts: { seqOffset: -(timeBase(T0) - 6 - 1) + 100 } });
    const v1 = seqOf(await stitcher.getMediaPlaylist('ch1', '1080p'));
    stitcher.switchTo('ch1', 'p-b', 'manual');
    clock.nowMs += 6000;
    const v2 = seqOf(await stitcher.getMediaPlaylist('ch1', '1080p'));
    expect(v2).toBeGreaterThan(v1); // never steps back to B's raw numbering
    expect(v2).toBeGreaterThan(1_000_000); // stays on the time-derived virtual base
    clock.nowMs += 5000;
    expect(seqOf(await stitcher.getMediaPlaylist('ch1', '1080p'))).toBeGreaterThanOrEqual(v2);
  });

  it('a fresh replica boots into the doc-selected upstream with a fresh time-derived base', async () => {
    const { stitcher, clock, net } = setup();
    const v1 = seqOf(await stitcher.getMediaPlaylist('ch1', '1080p'));

    clock.nowMs += 30_000;
    const stitcher2 = new Stitcher({
      cacheTtlMs: 2000,
      stallGraceSec: 10,
      fetchImpl: net.fetchImpl,
      now: () => clock.nowMs,
    });
    const doc = desiredDoc();
    doc.channels[0]!.activeUpstreamId = 'p-a'; // the upstream the previous instance was serving
    stitcher2.applyDesired(doc);
    const v2 = seqOf(await stitcher2.getMediaPlaylist('ch1', '1080p'));
    expect(v2).toBeGreaterThan(v1);
    expect(v2).toBe(timeBase(clock.nowMs)); // fresh time-derived base
  });

  it('a fresh replica boots directly into the doc-pushed active upstream', async () => {
    const { clock, net } = setup();
    const doc = desiredDoc();
    doc.channels[0]!.activeUpstreamId = 'p-b';
    const stitcher2 = new Stitcher({ cacheTtlMs: 2000, stallGraceSec: 10, fetchImpl: net.fetchImpl, now: () => clock.nowMs });
    stitcher2.applyDesired(doc);
    const status = stitcher2.channelStatuses()[0]!;
    expect(status.activeUpstreamId).toBe('p-b');
    expect(status.lastSwitch).toBeNull(); // initial pick from the doc, not a switch
    const text = await stitcher2.getMediaPlaylist('ch1', '1080p');
    expect(segmentUrisOf(text)[0]).toContain(segPrefix(NODE_B));
  });
});

describe('discontinuity bookkeeping', () => {
  it('inserts EXT-X-DISCONTINUITY exactly once per switch per variant and bumps DISCONTINUITY-SEQUENCE when it slides out', async () => {
    const { stitcher, clock } = setup();
    const before1080 = await stitcher.getMediaPlaylist('ch1', '1080p');
    const beforeAudio = await stitcher.getMediaPlaylist('ch1', 'arib_1');
    expect(discCount(before1080)).toBe(0);
    expect(discSeqOf(before1080)).toBe(0);
    const v1 = seqOf(before1080);
    expect(discCount(beforeAudio)).toBe(0);

    stitcher.switchTo('ch1', 'p-b', 'manual');
    clock.nowMs = T0 + 7000;

    const after1080 = await stitcher.getMediaPlaylist('ch1', '1080p');
    expect(discCount(after1080)).toBe(1);
    expect(discSeqOf(after1080)).toBe(0); // tag still in the playlist → sequence unchanged
    expect(seqOf(after1080)).toBeGreaterThan(v1);
    const afterAudio = await stitcher.getMediaPlaylist('ch1', 'arib_1');
    expect(discCount(afterAudio)).toBe(1); // each variant applies the channel-level switch once

    // re-render while the splice segment is still in the window: same single tag
    clock.nowMs = T0 + 9500;
    const again = await stitcher.getMediaPlaylist('ch1', '1080p');
    expect(discCount(again)).toBe(1);
    expect(discSeqOf(again)).toBe(0);

    // window slides past the splice point → tag leaves, sequence increments
    clock.nowMs = T0 + 40_000;
    const later = await stitcher.getMediaPlaylist('ch1', '1080p');
    expect(discCount(later)).toBe(0);
    expect(discSeqOf(later)).toBe(1);
    expect(seqOf(later)).toBeGreaterThan(seqOf(again));
  });
});

describe('served-window retention', () => {
  it('never collapses the served window on a hot-hot switch', async () => {
    const { stitcher, clock } = setup();
    const before = segmentUrisOf(await stitcher.getMediaPlaylist('ch1', '1080p'));
    expect(before).toHaveLength(6);

    stitcher.switchTo('ch1', 'p-b', 'manual');
    clock.nowMs = T0 + 6000; // one segment later
    const text = await stitcher.getMediaPlaylist('ch1', '1080p');
    const uris = segmentUrisOf(text);
    expect(uris.length).toBeGreaterThanOrEqual(6); // NOT collapsed to ~1 (the bug)
    expect(countFor(text, NODE_A)).toBeGreaterThan(0); // outgoing tail retained
    expect(uris.at(-1)).toContain(segPrefix(NODE_B)); // newest is the new upstream
    expect(discCount(text)).toBe(1);
  });

  it('drains the retained tail one-per-new-segment at a constant window size', async () => {
    const { stitcher, clock } = setup();
    await stitcher.getMediaPlaylist('ch1', '1080p');
    stitcher.switchTo('ch1', 'p-b', 'manual');

    let prevSeq = -Infinity;
    let prevA = 6;
    for (let step = 1; step <= 6; step += 1) {
      clock.nowMs = T0 + 1000 + step * 5000;
      const text = await stitcher.getMediaPlaylist('ch1', '1080p');
      expect(segmentUrisOf(text)).toHaveLength(6); // constant window
      const a = countFor(text, NODE_A);
      expect(a).toBeLessThan(prevA); // exactly one p-a drained each step
      expect(countFor(text, NODE_B)).toBe(6 - a);
      const seq = seqOf(text);
      expect(seq).toBeGreaterThan(prevSeq); // media-sequence monotonic + contiguous
      prevA = a;
      prevSeq = seq;
    }
    expect(prevA).toBe(0); // fully drained to p-b
  });

  it('reverts to plain single-upstream rendering after the tail drains', async () => {
    const { stitcher, clock } = setup();
    await stitcher.getMediaPlaylist('ch1', '1080p');
    stitcher.switchTo('ch1', 'p-b', 'manual');
    let text = '';
    for (let step = 1; step <= 8; step += 1) {
      clock.nowMs = T0 + 1000 + step * 5000;
      text = await stitcher.getMediaPlaylist('ch1', '1080p');
    }
    expect(segmentUrisOf(text).every((u) => u.startsWith(segPrefix(NODE_B)))).toBe(true);
    expect(discCount(text)).toBe(0); // the splice discontinuity aged out
    expect(discSeqOf(text)).toBe(1);
    const s1 = seqOf(text);
    clock.nowMs += 5000; // steady single-upstream slide
    expect(seqOf(await stitcher.getMediaPlaylist('ch1', '1080p'))).toBe(s1 + 1);
  });

  it('cold→hot promote (new upstream has no backlog) drains without collapsing', async () => {
    const { stitcher, clock } = setup({ bOpts: { window: 1 } });
    await stitcher.getMediaPlaylist('ch1', '1080p'); // p-a, full 6-segment window
    stitcher.switchTo('ch1', 'p-b', 'manual');
    clock.nowMs = T0 + 6000;
    const text = await stitcher.getMediaPlaylist('ch1', '1080p');
    // B offers only 1 segment, but the window is held at the pre-switch length
    expect(segmentUrisOf(text).length).toBeGreaterThanOrEqual(6);
    expect(countFor(text, NODE_A)).toBe(5);
    expect(countFor(text, NODE_B)).toBe(1);
  });

  it('switches back to the original upstream (A→B→A) monotonically', async () => {
    const { stitcher, clock } = setup();
    await stitcher.getMediaPlaylist('ch1', '1080p');
    stitcher.switchTo('ch1', 'p-b', 'manual');
    clock.nowMs = T0 + 11_000;
    const midSeq = seqOf(await stitcher.getMediaPlaylist('ch1', '1080p'));
    stitcher.switchTo('ch1', 'p-a', 'manual'); // switch back
    clock.nowMs = T0 + 21_000;
    const back = await stitcher.getMediaPlaylist('ch1', '1080p');
    expect(seqOf(back)).toBeGreaterThan(midSeq); // monotonic across both switches
    expect(segmentUrisOf(back).at(-1)).toContain(segPrefix(NODE_A)); // newest is p-a again
    expect(discCount(back)).toBeGreaterThanOrEqual(1); // a fresh discontinuity on re-entry
  });

  it('keeps the window across a chained switch A→B→C', async () => {
    const NODE_C = 'http://node-c/media/ch1';
    const { stitcher, clock, net } = setup();
    liveUpstream(net, NODE_C, clock);
    const doc = desiredDoc('rev-2');
    doc.channels[0]!.upstreams = [
      { id: 'p-a', url: NODE_A, priority: 1 },
      { id: 'p-b', url: NODE_B, priority: 2 },
      { id: 'p-c', url: NODE_C, priority: 3 },
    ];
    stitcher.applyDesired(doc);

    await stitcher.getMediaPlaylist('ch1', '1080p');
    stitcher.switchTo('ch1', 'p-b', 'manual');
    clock.nowMs = T0 + 8000;
    await stitcher.getMediaPlaylist('ch1', '1080p');
    stitcher.switchTo('ch1', 'p-c', 'manual');
    clock.nowMs = T0 + 13_000;
    const text = await stitcher.getMediaPlaylist('ch1', '1080p');
    expect(segmentUrisOf(text).length).toBeGreaterThanOrEqual(6); // never collapsed
    expect(discCount(text)).toBeGreaterThanOrEqual(1);
    expect(discCount(text)).toBeLessThanOrEqual(2); // at most two in-window boundaries
    expect(segmentUrisOf(text).at(-1)).toContain(segPrefix(NODE_C));
  });

  it('a fresh replica renders a clean window from the doc-pushed upstream, with no carried-over discontinuity', async () => {
    const { clock, net } = setup();
    clock.nowMs = T0 + 12_000;
    const doc = desiredDoc();
    doc.channels[0]!.activeUpstreamId = 'p-b';
    const stitcher2 = new Stitcher({
      cacheTtlMs: 2000,
      stallGraceSec: 10,
      fetchImpl: net.fetchImpl,
      now: () => clock.nowMs,
    });
    stitcher2.applyDesired(doc);
    const text = await stitcher2.getMediaPlaylist('ch1', '1080p');
    // no in-memory buffer to carry a splice boundary forward from — a fresh
    // instance's first render of an upstream is never flagged as a switch
    expect(segmentUrisOf(text).every((u) => u.startsWith(segPrefix(NODE_B)))).toBe(true);
    expect(seqOf(text)).toBe(timeBase(clock.nowMs));
    expect(discCount(text)).toBe(0);
  });
});

describe('PDT-aligned splice', () => {
  it('resumes the new upstream exactly at the splice point, behind the retained old tail', async () => {
    const { stitcher, clock } = setup();
    await stitcher.getMediaPlaylist('ch1', '1080p'); // last served segment ends at T0
    stitcher.switchTo('ch1', 'p-b', 'manual');

    clock.nowMs = T0 + 7000; // B's live window still overlaps [T0-25s, T0+5s]
    const text = await stitcher.getMediaPlaylist('ch1', '1080p');
    // the new upstream's own segments are only those PAST the splice point —
    // nothing already covered by the old upstream is replayed under the new id
    const bEntries = segEntries(text).filter((e) => e.uri.startsWith(segPrefix(NODE_B)));
    expect(bEntries.length).toBeGreaterThan(0);
    for (const e of bEntries) expect(e.pdt + 5000).toBeGreaterThan(T0);
    expect(Math.min(...bEntries.map((e) => e.pdt))).toBe(T0); // resumes exactly at the splice point

    // the retained p-a tail sits AHEAD of the p-b head (continuous window)
    const uris = segmentUrisOf(text);
    const firstB = uris.findIndex((u) => u.startsWith(segPrefix(NODE_B)));
    expect(firstB).toBeGreaterThan(0);
    expect(uris.slice(0, firstB).every((u) => u.startsWith(segPrefix(NODE_A)))).toBe(true);
  });
});

describe('health probing (no autonomous failover)', () => {
  it('marks the active upstream unhealthy and throws — never switches — when its fetch fails with a healthy candidate available', async () => {
    const { stitcher, net } = setup();
    net.routes[`${NODE_A}/1080p/stream.m3u8`] = () => ({ status: 500 });
    const err = await stitcher.getMediaPlaylist('ch1', '1080p').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UpstreamUnavailableError);
    const status = stitcher.channelStatuses()[0]!;
    expect(status.activeUpstreamId).toBe('p-a'); // p-b is healthy, but switching is the controller's job
    expect(status.lastSwitch).toBeNull();
    expect(status.upstreams.find((u) => u.id === 'p-a')?.healthy).toBe(false);
  });

  it('keeps serving a stale playlist and marks it unhealthy without switching (healthy candidate available)', async () => {
    const { stitcher, aOpts } = setup();
    aOpts.staleSec = 60; // lag 60s > 3×5 + 10 = 25s
    const text = await stitcher.getMediaPlaylist('ch1', '1080p');
    expect(segmentUrisOf(text)[0]).toContain(segPrefix(NODE_A)); // still serving the stale active upstream
    const status = stitcher.channelStatuses()[0]!;
    expect(status.activeUpstreamId).toBe('p-a');
    expect(status.lastSwitch).toBeNull();
    const a = status.upstreams.find((u) => u.id === 'p-a')!;
    expect(a.healthy).toBe(false);
    expect(a.playlistLagSec).toBeGreaterThan(55);
  });

  it('retains the active upstream and throws UpstreamUnavailableError when nothing is healthy', async () => {
    const { stitcher, net, clock } = setup();
    net.routes[`${NODE_B}/playlist.m3u8`] = () => new Error('connect ECONNREFUSED');
    await stitcher.probeAll(); // B now known-unhealthy
    clock.nowMs += 3000; // past the micro-cache warmed by the probe
    net.routes[`${NODE_A}/1080p/stream.m3u8`] = () => new Error('connect ECONNREFUSED');
    const err = await stitcher.getMediaPlaylist('ch1', '1080p').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UpstreamUnavailableError);
    expect((err as UpstreamUnavailableError).retryAfterSec).toBe(5);
    expect(stitcher.channelStatuses()[0]!.activeUpstreamId).toBe('p-a'); // stays put
  });

  it('keeps serving a stale playlist when no healthy alternative exists', async () => {
    const { stitcher, net, aOpts, clock } = setup();
    net.routes[`${NODE_B}/playlist.m3u8`] = () => ({ status: 502 });
    await stitcher.probeAll();
    clock.nowMs += 3000; // past the micro-cache warmed by the probe
    aOpts.staleSec = 120;
    const text = await stitcher.getMediaPlaylist('ch1', '1080p'); // stale but fetchable → still served
    expect(segmentUrisOf(text)[0]).toContain(segPrefix(NODE_A));
    expect(stitcher.channelStatuses()[0]!.activeUpstreamId).toBe('p-a');
  });

  it('probeAll refreshes health/lag for every upstream but never changes the active selection', async () => {
    const { stitcher, net, clock } = setup();
    await new Promise((resolve) => setImmediate(resolve)); // settle the eager setup probe
    clock.nowMs += 3000; // past the micro-cache warmed by the eager setup probe
    net.routes[`${NODE_A}/playlist.m3u8`] = () => new Error('connect ECONNREFUSED');
    await stitcher.probeAll(); // no viewer ever fetched anything
    const status = stitcher.channelStatuses()[0]!;
    expect(status.activeUpstreamId).toBe('p-a'); // unhealthy, but never self-switches
    expect(status.lastSwitch).toBeNull();
    expect(status.upstreams.find((u) => u.id === 'p-a')?.healthy).toBe(false);
    const b = status.upstreams.find((u) => u.id === 'p-b')!;
    expect(b.healthy).toBe(true);
    expect(b.playlistLagSec).toBeDefined(); // probe measured the media playlist
  });
});

describe('eager probe on push', () => {
  it('probes never-checked upstreams right after applyDesired without re-probing known ones', async () => {
    const { stitcher, net, clock } = setup();
    await stitcher.probeAll(); // p-a / p-b now known
    const NODE_C = 'http://node-c/media/ch1';
    liveUpstream(net, NODE_C, clock, {});
    const aMasterCalls = () => net.calls.filter((u) => u === `${NODE_A}/playlist.m3u8`).length;
    const before = aMasterCalls();
    clock.nowMs += 3000; // past the micro-cache
    const doc = desiredDoc('rev-2');
    doc.channels[0]!.upstreams.push({ id: 'p-c', url: NODE_C, priority: 3 });
    stitcher.applyDesired(doc);
    await new Promise((resolve) => setImmediate(resolve)); // flush the fire-and-forget probe
    const status = stitcher.channelStatuses()[0]!;
    const c = status.upstreams.find((u) => u.id === 'p-c')!;
    expect(c.healthy).toBe(true);
    expect(c.playlistLagSec).toBeDefined(); // really probed, not the optimistic default
    expect(aMasterCalls()).toBe(before); // already-checked sibling not re-hit
    expect(status.activeUpstreamId).toBe('p-a'); // eager probe never switches either
  });
});

describe('applyDesired', () => {
  it('keeps the active selection when its upstream survives the push', async () => {
    const { stitcher } = setup();
    stitcher.switchTo('ch1', 'p-b', 'manual');
    stitcher.applyDesired(desiredDoc('rev-2'));
    const status = stitcher.channelStatuses()[0]!;
    expect(status.activeUpstreamId).toBe('p-b');
    expect(status.lastSwitch?.reason).toBe('manual');
    expect(stitcher.desiredRevision).toBe('rev-2');
  });

  it('re-picks (reason push) when the active upstream disappears from the doc', () => {
    const { stitcher } = setup();
    stitcher.switchTo('ch1', 'p-b', 'manual');
    const doc = desiredDoc('rev-2');
    doc.channels[0]!.upstreams = [{ id: 'p-a', url: NODE_A, priority: 1 }];
    stitcher.applyDesired(doc);
    const status = stitcher.channelStatuses()[0]!;
    expect(status.activeUpstreamId).toBe('p-a');
    expect(status.lastSwitch).toMatchObject({ from: 'p-b', to: 'p-a', reason: 'push' });
  });

  it('new channels pick the priority-1 upstream regardless of array order; removed channels are dropped', () => {
    const { stitcher } = setup();
    const doc = desiredDoc('rev-2');
    doc.channels = [
      {
        slug: 'ch2',
        segmentSeconds: 5,
        upstreams: [
          { id: 'q-low', url: 'http://node-b/media/ch2', priority: 2 },
          { id: 'q-top', url: 'http://node-a/media/ch2', priority: 1 },
        ],
      },
    ];
    stitcher.applyDesired(doc);
    const statuses = stitcher.channelStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.slug).toBe('ch2');
    expect(statuses[0]!.activeUpstreamId).toBe('q-top');
    expect(statuses[0]!.lastSwitch).toBeNull(); // initial pick, not a switch
  });

  it('activeUpstreamId in the doc drives a real switch (reason push) with splice/discontinuity mechanics', async () => {
    const { stitcher, clock } = setup();
    await stitcher.getMediaPlaylist('ch1', '1080p'); // p-a served, splice cutoff established
    const doc = desiredDoc('rev-2');
    doc.channels[0]!.activeUpstreamId = 'p-b';
    stitcher.applyDesired(doc);
    const status = stitcher.channelStatuses()[0]!;
    expect(status.activeUpstreamId).toBe('p-b');
    expect(status.lastSwitch).toMatchObject({ from: 'p-a', to: 'p-b', reason: 'push' });

    clock.nowMs = T0 + 7000;
    const text = await stitcher.getMediaPlaylist('ch1', '1080p');
    expect(countFor(text, NODE_A)).toBeGreaterThan(0); // outgoing tail retained
    expect(discCount(text)).toBe(1); // splice discontinuity inserted
  });

  it('falls through to keep-current when activeUpstreamId names a nonexistent upstream', () => {
    const { stitcher } = setup();
    stitcher.switchTo('ch1', 'p-b', 'manual');
    const doc = desiredDoc('rev-2');
    doc.channels[0]!.activeUpstreamId = 'p-zzz';
    stitcher.applyDesired(doc);
    const status = stitcher.channelStatuses()[0]!;
    expect(status.activeUpstreamId).toBe('p-b'); // kept, the dangling reference is ignored
    expect(status.lastSwitch?.reason).toBe('manual'); // no new switch recorded
  });

  it('is a no-op when the doc names the already-active upstream', () => {
    const { stitcher } = setup();
    stitcher.switchTo('ch1', 'p-b', 'manual');
    const lastSwitchBefore = stitcher.channelStatuses()[0]!.lastSwitch;
    const doc = desiredDoc('rev-2');
    doc.channels[0]!.activeUpstreamId = 'p-b';
    stitcher.applyDesired(doc);
    const status = stitcher.channelStatuses()[0]!;
    expect(status.activeUpstreamId).toBe('p-b');
    expect(status.lastSwitch).toEqual(lastSwitchBefore); // unchanged, no new switch recorded
  });
});

describe('onDemandIdle channels', () => {
  it('probeAll and the eager push probe both skip channels flagged onDemandIdle', async () => {
    const { stitcher, net } = setup();
    await new Promise((resolve) => setImmediate(resolve)); // settle the eager setup probe
    net.calls.length = 0;
    const doc = desiredDoc('rev-2');
    doc.channels[0]!.onDemandIdle = true;
    stitcher.applyDesired(doc); // triggers the eager probeNeverChecked() internally
    await new Promise((resolve) => setImmediate(resolve)); // flush any fire-and-forget probe
    expect(net.calls).toHaveLength(0); // no eager probe for an idle channel

    await stitcher.probeAll();
    expect(net.calls).toHaveLength(0); // still no probe traffic
  });
});

describe('on-demand cold-start hold (waitServeable)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setupOnDemand() {
    const clock = { nowMs: T0 + 1000 };
    const net = makeFetch(); // cold: no routes registered — every fetch 404s
    const stitcher = new Stitcher({
      cacheTtlMs: 2000,
      stallGraceSec: 10,
      fetchImpl: net.fetchImpl,
      now: () => clock.nowMs,
    });
    const doc = desiredDoc();
    doc.channels[0]!.onDemand = true;
    stitcher.applyDesired(doc);
    return { clock, net, stitcher };
  }

  /** advances the injected clock and the fake timers together, in `step`-sized ticks */
  async function tick(clock: { nowMs: number }, totalMs: number, step = 1000): Promise<void> {
    let left = totalMs;
    while (left > 0) {
      const dt = Math.min(step, left);
      clock.nowMs += dt;
      await vi.advanceTimersByTimeAsync(dt);
      left -= dt;
    }
  }

  it('isOnDemand mirrors the pushed onDemand flag', () => {
    const { stitcher } = setupOnDemand();
    expect(stitcher.isOnDemand('ch1')).toBe(true);
    expect(stitcher.isOnDemand('nope')).toBe(false);
  });

  it('resolves true immediately when the active upstream is already serveable', async () => {
    const { net, stitcher } = setupOnDemand();
    liveUpstream(net, NODE_A, { nowMs: T0 + 1000 });
    expect(await stitcher.waitServeable('ch1', 1_000)).toBe(true);
  });

  it('resolves true once the active upstream becomes serveable mid-poll', async () => {
    const { clock, net, stitcher } = setupOnDemand();
    const p = stitcher.waitServeable('ch1', 20_000);
    let settled: boolean | undefined;
    void p.then((r) => {
      settled = r;
    });

    await tick(clock, 6_000); // several failed poll cycles while cold
    expect(settled).toBeUndefined(); // still holding, well short of the 20s deadline

    liveUpstream(net, NODE_A, clock); // the encode comes up
    await tick(clock, 4_000); // at least one more poll cycle to notice

    expect(await p).toBe(true);
  });

  it('resolves false once the deadline elapses without ever becoming serveable', async () => {
    const { clock, stitcher } = setupOnDemand();
    const p = stitcher.waitServeable('ch1', 5_000);
    await tick(clock, 7_000); // safely past the deadline, cold throughout
    expect(await p).toBe(false);
  });

  it('does not record a health transition while polling a down encode', async () => {
    const { clock, stitcher } = setupOnDemand();
    await new Promise((resolve) => setImmediate(resolve)); // settle the eager push probe (unrelated to the hold)
    const before = stitcher.channelStatuses()[0]!.upstreams.find((u) => u.id === 'p-a');
    const p = stitcher.waitServeable('ch1', 3_000);
    await tick(clock, 4_000);
    expect(await p).toBe(false);
    const after = stitcher.channelStatuses()[0]!.upstreams.find((u) => u.id === 'p-a');
    expect(after).toEqual(before); // no health churn caused by the hold's own polling
  });

  it("a successful probe warms the cache so the caller's post-hold retry avoids a duplicate fetch", async () => {
    const { net, stitcher } = setupOnDemand();
    liveUpstream(net, NODE_A, { nowMs: T0 + 1000 });
    expect(await stitcher.waitServeable('ch1', 1_000)).toBe(true);
    const callsBefore = net.calls.length;
    await stitcher.getMasterPlaylist('ch1');
    expect(net.calls.length).toBe(callsBefore); // served from the still-warm micro-cache
  });

  it('resolves false promptly when the signal aborts mid-hold', async () => {
    const { clock, stitcher } = setupOnDemand();
    const controller = new AbortController();
    const p = stitcher.waitServeable('ch1', 30_000, controller.signal);
    await tick(clock, 2_000); // enters the poll loop, still cold
    controller.abort();
    expect(await p).toBe(false);
  });
});

describe('manual switch', () => {
  it('throws for unknown slug or upstream and no-ops when already active', () => {
    const { stitcher } = setup();
    expect(() => stitcher.switchTo('nope', 'p-a', 'manual')).toThrow(UnknownChannelError);
    expect(() => stitcher.switchTo('ch1', 'p-zzz', 'manual')).toThrow(UnknownUpstreamError);
    stitcher.switchTo('ch1', 'p-a', 'manual'); // already active
    expect(stitcher.channelStatuses()[0]!.lastSwitch).toBeNull();
  });

  it('still switches on command while the active upstream is failing — the controller lever is never gated', async () => {
    const { stitcher, net } = setup();
    net.routes[`${NODE_A}/1080p/stream.m3u8`] = () => ({ status: 500 });
    await expect(stitcher.getMediaPlaylist('ch1', '1080p')).rejects.toBeInstanceOf(UpstreamUnavailableError);
    stitcher.switchTo('ch1', 'p-b', 'manual');
    const status = stitcher.channelStatuses()[0]!;
    expect(status.activeUpstreamId).toBe('p-b');
    expect(status.lastSwitch).toMatchObject({ from: 'p-a', to: 'p-b', reason: 'manual' });
  });
});

describe('micro-cache', () => {
  it('fetches an upstream playlist at most once per TTL', async () => {
    const { stitcher, net, clock } = setup();
    const mediaUrl = `${NODE_A}/1080p/stream.m3u8`;
    await stitcher.getMediaPlaylist('ch1', '1080p');
    await stitcher.getMediaPlaylist('ch1', '1080p');
    expect(net.calls.filter((u) => u === mediaUrl)).toHaveLength(1);
    clock.nowMs += 2500; // past cacheTtlMs (2000)
    await stitcher.getMediaPlaylist('ch1', '1080p');
    expect(net.calls.filter((u) => u === mediaUrl)).toHaveLength(2);
  });
});
