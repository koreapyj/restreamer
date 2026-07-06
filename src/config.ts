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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { parse } from 'yaml';

/**
 * Daemon configuration. All defaults are production values; an empty config
 * file is valid and yields pure defaults.
 */
export const DaemonConfigSchema = Type.Object({
  listen: Type.Object(
    {
      host: Type.String({ default: '0.0.0.0' }),
      port: Type.Integer({ minimum: 1, maximum: 65535, default: 5580 }),
    },
    { default: {} },
  ),
  /** HLS output root; each session writes to `<serveDir>/<name>/` (served by nginx) */
  serveDir: Type.String({ default: '/media' }),
  /** atomic JSON persistence of the accepted desired doc */
  stateFile: Type.String({ default: '/var/lib/restreamer/desired.json' }),
  /** local tvheadend instance the daemon subscribes to */
  tvhBaseUrl: Type.String({ default: 'http://127.0.0.1:9981' }),
  /**
   * local M3U catalog of external (non-tvheadend) sources, exposed via
   * `GET /v1/sources` (e.g. /etc/restreamer/sources.m3u); null = no catalog
   */
  sourcesM3u: Type.Union([Type.String(), Type.Null()], { default: null }),
  /** subscription weight when a session doesn't specify one */
  defaultWeight: Type.Number({ default: 100 }),
  ffmpegPath: Type.String({ default: 'ffmpeg' }),
  tsreadexPath: Type.String({ default: 'tsreadex' }),
  /** hardware capabilities advertised in /v1/status (matched against template requiredCaps) */
  capabilities: Type.Array(Type.String(), { default: ['qsv', 'opencl'] }),
  /** per-session stderr ring-buffer size */
  logLines: Type.Integer({ minimum: 0, default: 500 }),
  /** no ffmpeg -progress update for this long while running → classify stall */
  stallTimeoutSec: Type.Number({ default: 30 }),
  /** playlist PDT lag threshold; null = derive `3 × hls_time + 15` per session */
  playlistStallSec: Type.Union([Type.Number(), Type.Null()], { default: null }),
  /** ffmpeg+tsreadex RSS ceiling before a proactive oom-guard restart; null = disabled */
  memoryLimitMb: Type.Union([Type.Number(), Type.Null()], { default: 2048 }),
  /** graceful stop: source abort → SIGTERM after this many seconds → SIGKILL +5s */
  stopGraceSec: Type.Number({ default: 10 }),
  /** delete `<serveDir>/<name>/` when a session is removed from the desired doc */
  cleanupOnRemove: Type.Boolean({ default: true }),
});
export type DaemonConfig = Static<typeof DaemonConfigSchema>;

/** $RESTREAMER_CONFIG → ./config.yaml → /etc/restreamer/config.yaml */
function defaultConfigPath(): string {
  if (process.env.RESTREAMER_CONFIG) return process.env.RESTREAMER_CONFIG;
  const cwdCandidate = join(process.cwd(), 'config.yaml');
  if (existsSync(cwdCandidate)) return cwdCandidate;
  return '/etc/restreamer/config.yaml';
}

export function loadConfig(path = defaultConfigPath()): DaemonConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read config file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const raw: unknown = parse(text) ?? {};
  const config = Value.Default(DaemonConfigSchema, Value.Clone(raw));
  if (!Value.Check(DaemonConfigSchema, config)) {
    const details = [...Value.Errors(DaemonConfigSchema, config)]
      .map((e) => `${e.path || '/'}: ${e.message} (got ${JSON.stringify(e.value)})`)
      .join('; ');
    throw new Error(`invalid config ${path}: ${details}`);
  }
  return { ...config, tvhBaseUrl: config.tvhBaseUrl.replace(/\/+$/, '') };
}
