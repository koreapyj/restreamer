/*
 * Splice-core tests: URL rewriting, virtual MEDIA-SEQUENCE monotonicity
 * (window slide / low-sequence switch / restart), discontinuity bookkeeping,
 * PDT-aligned splice, health + autonomous failover, applyDesired selection
 * rules and the fetch micro-cache. Injected fetch + fake clock throughout.
 */

import { describe, expect, it } from 'vitest';
import {
  Stitcher,
  UnknownChannelError,
  UnknownUpstreamError,
  UpstreamUnavailableError,
  type SegmentUrlMode,
  type SelectionMap,
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
  segmentUrisOf,
  seqOf,
  type LiveOpts,
} from './fixtures.js';

/** virtual sequence base for segmentSeconds=5 */
const timeBase = (ms: number) => Math.floor(ms / 1000 / 5);

function setup(opts: { aOpts?: LiveOpts; bOpts?: LiveOpts; segmentUrls?: SegmentUrlMode } = {}) {
  const clock = { nowMs: T0 + 1000 };
  const net = makeFetch();
  const aOpts = liveUpstream(net, NODE_A, clock, opts.aOpts ?? {});
  const bOpts = liveUpstream(net, NODE_B, clock, opts.bOpts ?? {});
  let selectionChanges = 0;
  const stitcher = new Stitcher({
    cacheTtlMs: 2000,
    stallGraceSec: 10,
    ...(opts.segmentUrls !== undefined ? { segmentUrls: opts.segmentUrls } : {}),
    fetchImpl: net.fetchImpl,
    now: () => clock.nowMs,
    onSelectionsChanged: () => {
      selectionChanges += 1;
    },
  });
  stitcher.applyDesired(desiredDoc());
  return { clock, net, stitcher, aOpts, bOpts, changes: () => selectionChanges };
}

describe('master playlist rewriting', () => {
  for (const segmentUrls of ['redirect', 'upstream'] as const) {
    it(`keeps variant and audio/subtitle rendition URIs relative in ${segmentUrls} mode, the rest verbatim`, async () => {
      const { stitcher } = setup({ segmentUrls });
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
  }

  it('rejects unknown slugs', async () => {
    const { stitcher } = setup();
    await expect(stitcher.getMasterPlaylist('nope')).rejects.toBeInstanceOf(UnknownChannelError);
  });
});

describe('media playlist rewriting', () => {
  it('rewrites segment and EXT-X-MAP URIs to relative seg/<upstreamId>/<file> by default and passes PDT/EXTINF/TARGETDURATION through', async () => {
    const { stitcher, net, clock } = setup();
    const firstPdt = T0 - 30_000;
    net.routes[`${NODE_A}/1080p/stream.m3u8`] = () =>
      mediaPlaylist({ mediaSeq: 100, firstPdtMs: firstPdt, count: 6, map: 'init.mp4' });
    const text = await stitcher.getMediaPlaylist('ch1', '1080p');
    expect(text).toContain('#EXT-X-MAP:URI="seg/p-a/init.mp4"');
    expect(segmentUrisOf(text)).toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => `seg/p-a/${segName(firstPdt + i * 5000)}`),
    );
    expect(text).not.toContain('node-a'); // fully relative — mountable anywhere
    expect(text).toContain('#EXT-X-TARGETDURATION:5');
    expect(text).toContain('#EXTINF:5.000000,');
    expect(text).toContain(`#EXT-X-PROGRAM-DATE-TIME:${new Date(firstPdt).toISOString()}`);
    // raw sequence 100 replaced by the time-derived virtual sequence
    expect(seqOf(text)).toBe(timeBase(clock.nowMs));
    expect(discSeqOf(text)).toBe(0);
  });

  it("absolutizes segment and EXT-X-MAP URIs against the upstream in 'upstream' mode (legacy shape)", async () => {
    const { stitcher, net, clock } = setup({ segmentUrls: 'upstream' });
    const firstPdt = T0 - 30_000;
    net.routes[`${NODE_A}/1080p/stream.m3u8`] = () =>
      mediaPlaylist({ mediaSeq: 100, firstPdtMs: firstPdt, count: 6, map: 'init.mp4' });
    const text = await stitcher.getMediaPlaylist('ch1', '1080p');
    expect(text).toContain(`#EXT-X-MAP:URI="${NODE_A}/1080p/init.mp4"`);
    expect(segmentUrisOf(text)).toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => `${NODE_A}/1080p/${segName(firstPdt + i * 5000)}`),
    );
    expect(text).not.toContain('seg/');
    expect(seqOf(text)).toBe(timeBase(clock.nowMs));
    expect(discSeqOf(text)).toBe(0);
  });

  it('retains the outgoing-upstream tail across a switch, then fully drains to the new id', async () => {
    const { stitcher, clock } = setup();
    const before = await stitcher.getMediaPlaylist('ch1', '1080p');
    // a viewer caching this playlist can still resolve every segment via p-a
    expect(segmentUrisOf(before).every((u) => u.startsWith('seg/p-a/'))).toBe(true);

    stitcher.switchTo('ch1', 'p-b', 'manual');
    clock.nowMs = T0 + 7000;
    const after = await stitcher.getMediaPlaylist('ch1', '1080p');
    // the window did NOT collapse: the p-a tail is retained ahead of the new p-b head
    expect(countFor(after, 'p-a')).toBeGreaterThan(0);
    expect(segmentUrisOf(after).at(-1)).toContain('seg/p-b/');

    // after ~one window of new segments the retained tail has drained out
    clock.nowMs = T0 + 45_000;
    const drained = await stitcher.getMediaPlaylist('ch1', '1080p');
    expect(segmentUrisOf(drained).length).toBeGreaterThan(0);
    expect(segmentUrisOf(drained).every((u) => u.startsWith('seg/p-b/'))).toBe(true);
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

  it('stays monotonic across a switcher restart (new instance, later wall clock)', async () => {
    const { stitcher, clock, net } = setup();
    const v1 = seqOf(await stitcher.getMediaPlaylist('ch1', '1080p'));
    const selections: SelectionMap = stitcher.getSelections();

    clock.nowMs += 30_000;
    const stitcher2 = new Stitcher({
      cacheTtlMs: 2000,
      stallGraceSec: 10,
      fetchImpl: net.fetchImpl,
      now: () => clock.nowMs,
    });
    stitcher2.applyDesired(desiredDoc(), selections);
    const v2 = seqOf(await stitcher2.getMediaPlaylist('ch1', '1080p'));
    expect(v2).toBeGreaterThan(v1);
    expect(v2).toBe(timeBase(clock.nowMs)); // fresh time-derived base
  });

  it('restores the persisted selection on restart', async () => {
    const { stitcher, clock, net } = setup();
    stitcher.switchTo('ch1', 'p-b', 'manual');
    const selections = stitcher.getSelections();

    const stitcher2 = new Stitcher({ cacheTtlMs: 2000, stallGraceSec: 10, fetchImpl: net.fetchImpl, now: () => clock.nowMs });
    stitcher2.applyDesired(desiredDoc(), selections);
    const status = stitcher2.channelStatuses()[0]!;
    expect(status.activeUpstreamId).toBe('p-b');
    expect(status.lastSwitch).toMatchObject({ to: 'p-b', reason: 'manual', from: null });
    const text = await stitcher2.getMediaPlaylist('ch1', '1080p');
    expect(segmentUrisOf(text)[0]).toContain('seg/p-b/');
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
    expect(countFor(text, 'p-a')).toBeGreaterThan(0); // outgoing tail retained
    expect(uris.at(-1)).toContain('seg/p-b/'); // newest is the new upstream
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
      const a = countFor(text, 'p-a');
      expect(a).toBeLessThan(prevA); // exactly one p-a drained each step
      expect(countFor(text, 'p-b')).toBe(6 - a);
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
    expect(segmentUrisOf(text).every((u) => u.startsWith('seg/p-b/'))).toBe(true);
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
    expect(countFor(text, 'p-a')).toBe(5);
    expect(countFor(text, 'p-b')).toBe(1);
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
    expect(segmentUrisOf(back).at(-1)).toContain('seg/p-a/'); // newest is p-a again
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
    expect(segmentUrisOf(text).at(-1)).toContain('seg/p-c/');
  });

  it('rebuilds from the active upstream after a restart mid-drain', async () => {
    const { stitcher, clock, net } = setup();
    await stitcher.getMediaPlaylist('ch1', '1080p');
    stitcher.switchTo('ch1', 'p-b', 'manual');
    clock.nowMs = T0 + 7000;
    await stitcher.getMediaPlaylist('ch1', '1080p'); // mid-drain: 5 p-a + 1 p-b
    const selections = stitcher.getSelections();

    // "restart": fresh instance, in-memory buffer lost
    clock.nowMs = T0 + 12_000;
    const stitcher2 = new Stitcher({
      cacheTtlMs: 2000,
      stallGraceSec: 10,
      fetchImpl: net.fetchImpl,
      now: () => clock.nowMs,
    });
    stitcher2.applyDesired(desiredDoc(), selections);
    const text = await stitcher2.getMediaPlaylist('ch1', '1080p');
    // clean re-window from the active upstream — monotonic, no spurious boundary
    expect(segmentUrisOf(text).every((u) => u.startsWith('seg/p-b/'))).toBe(true);
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
    const bEntries = segEntries(text).filter((e) => e.uri.startsWith('seg/p-b/'));
    expect(bEntries.length).toBeGreaterThan(0);
    for (const e of bEntries) expect(e.pdt + 5000).toBeGreaterThan(T0);
    expect(Math.min(...bEntries.map((e) => e.pdt))).toBe(T0); // resumes exactly at the splice point

    // the retained p-a tail sits AHEAD of the p-b head (continuous window)
    const uris = segmentUrisOf(text);
    const firstB = uris.findIndex((u) => u.startsWith('seg/p-b/'));
    expect(firstB).toBeGreaterThan(0);
    expect(uris.slice(0, firstB).every((u) => u.startsWith('seg/p-a/'))).toBe(true);
  });
});

describe('health and autonomous failover', () => {
  it('fails over to the next-priority upstream when the active fetch fails', async () => {
    const { stitcher, net, changes } = setup();
    net.routes[`${NODE_A}/1080p/stream.m3u8`] = () => ({ status: 500 });
    const before = changes();
    const text = await stitcher.getMediaPlaylist('ch1', '1080p');
    expect(segmentUrisOf(text)[0]).toContain('seg/p-b/');
    const status = stitcher.channelStatuses()[0]!;
    expect(status.activeUpstreamId).toBe('p-b');
    expect(status.lastSwitch).toMatchObject({ from: 'p-a', to: 'p-b', reason: 'failover' });
    expect(status.upstreams.find((u) => u.id === 'p-a')?.healthy).toBe(false);
    expect(changes()).toBeGreaterThan(before); // selection change persisted via hook
  });

  it('fails over when the active playlist PDT is stale (lag > 3×segmentSeconds + grace)', async () => {
    const { stitcher, aOpts } = setup();
    aOpts.staleSec = 60; // lag 60s > 3×5 + 10 = 25s
    const text = await stitcher.getMediaPlaylist('ch1', '1080p');
    expect(segmentUrisOf(text)[0]).toContain('seg/p-b/');
    const status = stitcher.channelStatuses()[0]!;
    expect(status.activeUpstreamId).toBe('p-b');
    expect(status.lastSwitch?.reason).toBe('failover');
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
    expect(segmentUrisOf(text)[0]).toContain('seg/p-a/');
    expect(stitcher.channelStatuses()[0]!.activeUpstreamId).toBe('p-a');
  });

  it('background probe refreshes health for all upstreams and fails over unwatched channels', async () => {
    const { stitcher, net } = setup();
    net.routes[`${NODE_A}/playlist.m3u8`] = () => new Error('connect ECONNREFUSED');
    await stitcher.probeAll(); // no viewer ever fetched anything
    const status = stitcher.channelStatuses()[0]!;
    expect(status.activeUpstreamId).toBe('p-b');
    expect(status.lastSwitch?.reason).toBe('failover');
    expect(status.upstreams.find((u) => u.id === 'p-a')?.healthy).toBe(false);
    const b = status.upstreams.find((u) => u.id === 'p-b')!;
    expect(b.healthy).toBe(true);
    expect(b.playlistLagSec).toBeDefined(); // probe measured the media playlist
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
    expect(stitcher.getSelections()['ch1']).toMatchObject({ upstreamId: 'p-a', reason: 'push' });
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
    expect(stitcher.getSelections()['ch1']).toBeUndefined(); // pruned
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
