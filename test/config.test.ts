/*
 * loadConfig() validation via temp YAML files — never reads a real
 * config.yaml.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  let dir: string;
  const savedEnv = process.env.RESTREAMER_CONFIG;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.RESTREAMER_CONFIG;
    else process.env.RESTREAMER_CONFIG = savedEnv;
  });

  function writeConfig(yaml: string): string {
    dir = mkdtempSync(join(tmpdir(), 'restreamer-config-test-'));
    const path = join(dir, 'config.yaml');
    writeFileSync(path, yaml, 'utf8');
    return path;
  }

  it('applies all production defaults to an empty config', () => {
    const path = writeConfig('');
    const cfg = loadConfig(path);
    expect(cfg).toEqual({
      listen: { host: '0.0.0.0', port: 5580 },
      serveDir: '/media',
      stateFile: '/var/lib/restreamer/desired.json',
      tvhBaseUrl: 'http://127.0.0.1:9981',
      sourcesM3u: null,
      defaultWeight: 100,
      ffmpegPath: 'ffmpeg',
      tsreadexPath: 'tsreadex',
      capabilities: ['qsv', 'opencl'],
      logLines: 500,
      stallTimeoutSec: 30,
      playlistStallSec: null,
      memoryLimitMb: 2048,
      stopGraceSec: 10,
      cleanupOnRemove: true,
    });
  });

  it('merges partial overrides with defaults', () => {
    const path = writeConfig(`
listen:
  port: 6600
serveDir: /srv/hls
tvhBaseUrl: http://tvh.local:9981/
capabilities: []
memoryLimitMb: null
playlistStallSec: 45
cleanupOnRemove: false
`);
    const cfg = loadConfig(path);
    expect(cfg.listen).toEqual({ host: '0.0.0.0', port: 6600 });
    expect(cfg.serveDir).toBe('/srv/hls');
    expect(cfg.tvhBaseUrl).toBe('http://tvh.local:9981'); // trailing slash stripped
    expect(cfg.capabilities).toEqual([]);
    expect(cfg.memoryLimitMb).toBeNull();
    expect(cfg.playlistStallSec).toBe(45);
    expect(cfg.cleanupOnRemove).toBe(false);
    expect(cfg.stateFile).toBe('/var/lib/restreamer/desired.json'); // default, untouched
    expect(cfg.sourcesM3u).toBeNull(); // default, untouched
  });

  it('accepts an explicit sourcesM3u path', () => {
    const path = writeConfig('sourcesM3u: /etc/restreamer/sources.m3u\n');
    expect(loadConfig(path).sourcesM3u).toBe('/etc/restreamer/sources.m3u');
  });

  it('accepts an explicit sourcesM3u null', () => {
    const path = writeConfig('sourcesM3u: null\n');
    expect(loadConfig(path).sourcesM3u).toBeNull();
  });

  it('resolves the config path from $RESTREAMER_CONFIG', () => {
    const path = writeConfig('listen: { port: 7700 }\n');
    process.env.RESTREAMER_CONFIG = path;
    const cfg = loadConfig();
    expect(cfg.listen.port).toBe(7700);
  });

  it('rejects a non-integer port with a clear message', () => {
    const path = writeConfig('listen: { port: not-a-port }\n');
    expect(() => loadConfig(path)).toThrow(/invalid config .*listen\/port/);
  });

  it('rejects an out-of-range port', () => {
    const path = writeConfig('listen: { port: 70000 }\n');
    expect(() => loadConfig(path)).toThrow(/invalid config/);
  });

  it('rejects a wrongly-typed capabilities value', () => {
    const path = writeConfig('capabilities: qsv\n');
    expect(() => loadConfig(path)).toThrow(/invalid config .*capabilities/);
  });

  it('throws a readable error for a missing file', () => {
    expect(() => loadConfig(join(tmpdir(), 'restreamer-definitely-missing.yaml'))).toThrow(
      /cannot read config file/,
    );
  });
});
