/*
 * SwitcherStore: roundtrip of the single desired+selections JSON file,
 * missing-file behavior, and corrupt/schema-invalid files being moved aside.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SwitcherStore } from '../../src/switcher/desiredStore.js';
import type { SelectionMap } from '../../src/switcher/stitch.js';
import { desiredDoc } from './fixtures.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe('SwitcherStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'switcher-store-test-'));
    file = join(dir, 'state', 'desired.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('roundtrips desired doc + selections through one file', async () => {
    const store = new SwitcherStore(file, silent);
    const selections: SelectionMap = {
      ch1: { upstreamId: 'p-b', switchedAt: '2026-07-06T00:00:00.000Z', reason: 'failover' },
    };
    await store.save(desiredDoc('rev-42'), selections);
    const loaded = await store.load();
    expect(loaded.desired).toEqual(desiredDoc('rev-42'));
    expect(loaded.selections).toEqual(selections);
  });

  it('returns empty state for a missing file', async () => {
    const store = new SwitcherStore(file, silent);
    await expect(store.load()).resolves.toEqual({ desired: null, selections: {} });
  });

  it('moves an unparseable file aside and starts empty', async () => {
    const store = new SwitcherStore(file, silent);
    await store.save(desiredDoc(), {}); // creates the directory
    writeFileSync(file, '{ this is not json', 'utf8');
    const loaded = await store.load();
    expect(loaded).toEqual({ desired: null, selections: {} });
    expect(existsSync(file)).toBe(false);
    const aside = readdirSync(join(dir, 'state')).filter((f) => f.includes('.corrupt-'));
    expect(aside).toHaveLength(1);
  });

  it('treats a schema-invalid file as corrupt', async () => {
    const store = new SwitcherStore(file, silent);
    await store.save(desiredDoc(), {});
    writeFileSync(file, JSON.stringify({ desired: { apiVersion: 99 }, selections: {} }), 'utf8');
    const loaded = await store.load();
    expect(loaded).toEqual({ desired: null, selections: {} });
    expect(readdirSync(join(dir, 'state')).some((f) => f.includes('.corrupt-'))).toBe(true);
  });
});
