/*
 * loadSwitcherConfig() validation via temp YAML files — never reads a real
 * switcher.yaml.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSwitcherConfig } from '../../src/switcher/config.js';

describe('loadSwitcherConfig', () => {
  let dir: string;
  const savedEnv = process.env.SWITCHER_CONFIG;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.SWITCHER_CONFIG;
    else process.env.SWITCHER_CONFIG = savedEnv;
  });

  function writeConfig(yaml: string): string {
    dir = mkdtempSync(join(tmpdir(), 'switcher-config-test-'));
    const path = join(dir, 'switcher.yaml');
    writeFileSync(path, yaml, 'utf8');
    return path;
  }

  it('applies all defaults to an empty config', () => {
    const cfg = loadSwitcherConfig(writeConfig(''));
    expect(cfg).toEqual({
      listen: { host: '0.0.0.0', port: 5590 },
      stateFile: '/var/lib/switcher/desired.json',
      cacheTtlMs: 2000,
      probeIntervalMs: 15_000,
      stallGraceSec: 10,
    });
  });

  it('merges partial overrides with defaults', () => {
    const cfg = loadSwitcherConfig(
      writeConfig('listen: { port: 6600 }\ncacheTtlMs: 500\nstallGraceSec: 20\n'),
    );
    expect(cfg.listen).toEqual({ host: '0.0.0.0', port: 6600 });
    expect(cfg.cacheTtlMs).toBe(500);
    expect(cfg.stallGraceSec).toBe(20);
    expect(cfg.probeIntervalMs).toBe(15_000); // default, untouched
  });

  it('resolves the config path from $SWITCHER_CONFIG', () => {
    process.env.SWITCHER_CONFIG = writeConfig('listen: { port: 7700 }\n');
    expect(loadSwitcherConfig().listen.port).toBe(7700);
  });

  it('rejects an invalid port with a clear message', () => {
    expect(() => loadSwitcherConfig(writeConfig('listen: { port: 70000 }\n'))).toThrow(/invalid config/);
  });

  it('throws a readable error for a missing file', () => {
    expect(() => loadSwitcherConfig(join(tmpdir(), 'switcher-definitely-missing.yaml'))).toThrow(
      /cannot read config file/,
    );
  });
});
