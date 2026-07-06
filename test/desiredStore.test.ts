/*
 * DesiredStore: atomic roundtrip, missing-file → null, corrupt file moved
 * aside (never crash-loops the daemon).
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DesiredState } from '../src/contract/v1.js';
import { DesiredStore } from '../src/state/desiredStore.js';
import { silentLogger } from './support/fakes.js';

const doc: DesiredState = {
  apiVersion: 1,
  revision: 'rev-1',
  sessions: [
    {
      name: 'at-x',
      source: { channelUuid: 'uuid-1' },
      tsreadex: { programNumber: 1064 },
      pipeline: { template: 'arib-hls', templateVersion: 1, video: { mode: 'ivtc' }, audio: [{}] },
    },
  ],
};

describe('DesiredStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'restreamer-store-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('roundtrips a desired doc', async () => {
    const store = new DesiredStore(join(dir, 'desired.json'), silentLogger);
    await store.save(doc);
    expect(await store.load()).toEqual(doc);
  });

  it('creates missing parent directories on save', async () => {
    const store = new DesiredStore(join(dir, 'var', 'lib', 'restreamer', 'desired.json'), silentLogger);
    await store.save(doc);
    expect(await store.load()).toEqual(doc);
  });

  it('returns null when the file does not exist', async () => {
    const store = new DesiredStore(join(dir, 'nope.json'), silentLogger);
    expect(await store.load()).toBeNull();
  });

  it('moves a corrupt file aside and returns null', async () => {
    const path = join(dir, 'desired.json');
    await writeFile(path, '{"apiVersion":1,"revision":"rev-1","sessi');
    const errors: string[] = [];
    const store = new DesiredStore(path, { info() {}, warn() {}, error: (m) => errors.push(m) });
    expect(await store.load()).toBeNull();
    const entries = await readdir(dir);
    const aside = entries.find((e) => e.startsWith('desired.json.corrupt-'));
    expect(aside).toBeDefined();
    expect(await readFile(join(dir, aside as string), 'utf8')).toContain('"sessi');
    expect(entries).not.toContain('desired.json');
    expect(errors.length).toBe(1); // logged loudly
    // subsequent load: file is gone → plain null
    expect(await store.load()).toBeNull();
  });

  it('treats parseable-but-non-object JSON as corrupt', async () => {
    const path = join(dir, 'desired.json');
    await writeFile(path, '[1,2,3]');
    const store = new DesiredStore(path, silentLogger);
    expect(await store.load()).toBeNull();
    expect((await readdir(dir)).some((e) => e.startsWith('desired.json.corrupt-'))).toBe(true);
  });

  it('save is a full replacement (no merge with previous content)', async () => {
    const store = new DesiredStore(join(dir, 'desired.json'), silentLogger);
    await store.save(doc);
    const next: DesiredState = { apiVersion: 1, revision: 'rev-2', sessions: [] };
    await store.save(next);
    expect(await store.load()).toEqual(next);
  });
});
