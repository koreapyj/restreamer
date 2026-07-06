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

/* SourcesCatalog with injected fs + timers — no real filesystem, no real clock. */

import { describe, expect, it } from 'vitest';
import { type CatalogFs, type CatalogTimers, SourcesCatalog } from '../src/sources/catalog.js';
import { silentLogger } from './support/fakes.js';

const M3U_A = ['#EXTM3U', '#EXTINF:-1 tvg-id="a" tvg-chno="1",Chan A', 'http://a/'].join('\n');
const M3U_B = ['#EXTM3U', '#EXTINF:-1 tvg-id="b" tvg-chno="2",Chan B', 'http://b/'].join('\n');

interface FakeFile {
  fs: CatalogFs;
  set(content: string, mtimeMs: number): void;
  remove(): void;
  reads: number;
  stats: number;
  failReads: boolean;
}

function fakeFile(content: string, mtimeMs: number): FakeFile {
  let file: { content: string; mtimeMs: number } | null = { content, mtimeMs };
  const self: FakeFile = {
    reads: 0,
    stats: 0,
    failReads: false,
    set(c, m) {
      file = { content: c, mtimeMs: m };
    },
    remove() {
      file = null;
    },
    fs: {
      stat: async () => {
        self.stats++;
        if (!file) throw new Error('ENOENT: no such file');
        return { mtimeMs: file.mtimeMs };
      },
      readFile: async () => {
        self.reads++;
        if (!file || self.failReads) throw new Error('EACCES: permission denied');
        return file.content;
      },
    },
  };
  return self;
}

interface FakeTimers extends CatalogTimers {
  /** run every registered interval callback once and let async polls settle */
  tick(): Promise<void>;
  intervals: Array<{ fn: () => void; ms: number; cleared: boolean }>;
}

function fakeTimers(): FakeTimers {
  const intervals: FakeTimers['intervals'] = [];
  return {
    intervals,
    setInterval(fn, ms) {
      const entry = { fn, ms, cleared: false };
      intervals.push(entry);
      return entry;
    },
    clearInterval(handle) {
      const entry = intervals.find((i) => i === handle);
      if (entry) entry.cleared = true;
    },
    async tick() {
      for (const i of intervals) if (!i.cleared) i.fn();
      // poll() is async — drain the microtask queue
      for (let n = 0; n < 10; n++) await Promise.resolve();
    },
  };
}

describe('SourcesCatalog', () => {
  it('loads the file immediately on start() and registers a 5s poll', async () => {
    const file = fakeFile(M3U_A, 1000);
    const timers = fakeTimers();
    const catalog = new SourcesCatalog('/etc/restreamer/sources.m3u', {
      fs: file.fs,
      timers,
      logger: silentLogger,
    });
    await catalog.start();

    const snap = catalog.snapshot();
    expect(snap.apiVersion).toBe(1);
    expect(snap.entries).toEqual([{ id: 'a', name: 'Chan A', url: 'http://a/', chno: '1' }]);
    expect(snap.catalogHash).toBeTypeOf('string');
    expect(snap.updatedAt).toBe(new Date(1000).toISOString());
    expect(snap.warnings).toBeUndefined();
    expect(catalog.hash).toBe(snap.catalogHash);
    expect(timers.intervals).toHaveLength(1);
    expect(timers.intervals[0]?.ms).toBe(5000);
    catalog.stop();
    expect(timers.intervals[0]?.cleared).toBe(true);
  });

  it('re-parses on mtime change: entries, hash and updatedAt move', async () => {
    const file = fakeFile(M3U_A, 1000);
    const timers = fakeTimers();
    const catalog = new SourcesCatalog('/s.m3u', { fs: file.fs, timers, logger: silentLogger });
    await catalog.start();
    const before = catalog.snapshot();

    file.set(M3U_B, 2000);
    await timers.tick();

    const after = catalog.snapshot();
    expect(after.entries).toEqual([{ id: 'b', name: 'Chan B', url: 'http://b/', chno: '2' }]);
    expect(after.catalogHash).not.toBe(before.catalogHash);
    expect(after.updatedAt).toBe(new Date(2000).toISOString());
    expect(catalog.hash).toBe(after.catalogHash);
  });

  it('does not re-read the file while the mtime is unchanged', async () => {
    const file = fakeFile(M3U_A, 1000);
    const timers = fakeTimers();
    const catalog = new SourcesCatalog('/s.m3u', { fs: file.fs, timers, logger: silentLogger });
    await catalog.start();
    expect(file.reads).toBe(1);

    await timers.tick();
    await timers.tick();
    expect(file.stats).toBe(3); // stat every poll…
    expect(file.reads).toBe(1); // …but no re-read
    expect(catalog.snapshot().entries).toHaveLength(1);
  });

  it('same content re-written (mtime bump) keeps the hash stable', async () => {
    const file = fakeFile(M3U_A, 1000);
    const timers = fakeTimers();
    const catalog = new SourcesCatalog('/s.m3u', { fs: file.fs, timers, logger: silentLogger });
    await catalog.start();
    const before = catalog.hash;

    file.set(M3U_A, 2000);
    await timers.tick();
    expect(file.reads).toBe(2);
    expect(catalog.hash).toBe(before);
  });

  it('keeps the last good catalog on read failure and appends a warning', async () => {
    const file = fakeFile(M3U_A, 1000);
    const timers = fakeTimers();
    const catalog = new SourcesCatalog('/s.m3u', { fs: file.fs, timers, logger: silentLogger });
    await catalog.start();
    const good = catalog.snapshot();

    file.set(M3U_B, 2000);
    file.failReads = true;
    await timers.tick();

    const degraded = catalog.snapshot();
    expect(degraded.entries).toEqual(good.entries); // last good kept
    expect(degraded.catalogHash).toBe(good.catalogHash);
    expect(degraded.updatedAt).toBe(good.updatedAt);
    expect(degraded.warnings).toHaveLength(1);
    expect(degraded.warnings?.[0]).toMatch(/cannot read sources catalog/);

    // repeated failures do not stack duplicate warnings
    await timers.tick();
    expect(catalog.snapshot().warnings).toHaveLength(1);

    // recovery re-reads and clears the failure warning
    file.failReads = false;
    await timers.tick();
    const recovered = catalog.snapshot();
    expect(recovered.entries).toEqual([{ id: 'b', name: 'Chan B', url: 'http://b/', chno: '2' }]);
    expect(recovered.warnings).toBeUndefined();
  });

  it('keeps the last good catalog when the file disappears (stat failure)', async () => {
    const file = fakeFile(M3U_A, 1000);
    const timers = fakeTimers();
    const catalog = new SourcesCatalog('/s.m3u', { fs: file.fs, timers, logger: silentLogger });
    await catalog.start();

    file.remove();
    await timers.tick();

    const snap = catalog.snapshot();
    expect(snap.entries).toEqual([{ id: 'a', name: 'Chan A', url: 'http://a/', chno: '1' }]);
    expect(snap.warnings?.[0]).toMatch(/cannot stat sources catalog/);
  });

  it('surfaces parse warnings in the snapshot', async () => {
    const file = fakeFile('#EXTINF:-1 tvg-id="w",Warned\n', 1000); // EXTINF without URL
    const timers = fakeTimers();
    const catalog = new SourcesCatalog('/s.m3u', { fs: file.fs, timers, logger: silentLogger });
    await catalog.start();

    const snap = catalog.snapshot();
    expect(snap.entries).toEqual([]);
    expect(snap.warnings).toHaveLength(1);
    expect(snap.warnings?.[0]).toMatch(/#EXTINF without a URL/);
    expect(snap.catalogHash).toBeTypeOf('string'); // parsed OK — hash of []
  });

  it('with a null path stays permanently empty: null hash, no fs or timer use', async () => {
    const file = fakeFile(M3U_A, 1000);
    const timers = fakeTimers();
    const catalog = new SourcesCatalog(null, { fs: file.fs, timers, logger: silentLogger });
    await catalog.start();

    expect(catalog.snapshot()).toEqual({ apiVersion: 1, catalogHash: null, updatedAt: null, entries: [] });
    expect(catalog.hash).toBeNull();
    expect(file.stats).toBe(0);
    expect(timers.intervals).toHaveLength(0);
    catalog.stop(); // no-op, must not throw
  });
});
