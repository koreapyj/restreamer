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
 * Switcher configuration. Same conventions as the daemon's config.ts for
 * every other key: optional, defaulted. `controllerUrl` is the one required
 * key — an empty file is not valid.
 */
export const SwitcherConfigSchema = Type.Object({
  listen: Type.Object(
    {
      host: Type.String({ default: '0.0.0.0' }),
      port: Type.Integer({ minimum: 1, maximum: 65535, default: 5590 }),
    },
    { default: {} },
  ),
  /** the controller's WS endpoint this switcher dials, e.g. ws://controller:8080/ws/switcher — see controllerLink.ts */
  controllerUrl: Type.String({ minLength: 1 }),
  /** per-(slug,variant,upstream) micro-cache of upstream playlist fetches */
  cacheTtlMs: Type.Number({ minimum: 0, default: 2000 }),
  /** background health probe period for ALL upstreams of ALL channels (keeps health fresh for unwatched channels) */
  probeIntervalMs: Type.Number({ minimum: 100, default: 15_000 }),
  /** failover threshold = 3 × segmentSeconds + stallGraceSec of upstream playlist PDT lag */
  stallGraceSec: Type.Number({ minimum: 0, default: 10 }),
  /**
   * Media-playlist segment URI shape: absolute upstream node URLs. Only
   * value ever used in production. Kept as an explicit single-literal key
   * (rather than dropped) so that an old config file still saying
   * `segmentUrls: redirect` (the removed 302-redirect mode) fails schema
   * validation loudly at startup instead of the loader — which does not
   * reject unknown keys — silently ignoring the line and changing behavior.
   */
  segmentUrls: Type.Literal('upstream', { default: 'upstream' }),
});
export type SwitcherConfig = Static<typeof SwitcherConfigSchema>;

/** $SWITCHER_CONFIG → ./switcher.yaml → /etc/restreamer/switcher.yaml */
function defaultConfigPath(): string {
  if (process.env.SWITCHER_CONFIG) return process.env.SWITCHER_CONFIG;
  const cwdCandidate = join(process.cwd(), 'switcher.yaml');
  if (existsSync(cwdCandidate)) return cwdCandidate;
  return '/etc/restreamer/switcher.yaml';
}

export function loadSwitcherConfig(path = defaultConfigPath()): SwitcherConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read config file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const raw: unknown = parse(text) ?? {};
  const config = Value.Default(SwitcherConfigSchema, Value.Clone(raw));
  if (!Value.Check(SwitcherConfigSchema, config)) {
    const details = [...Value.Errors(SwitcherConfigSchema, config)]
      .map((e) => `${e.path || '/'}: ${e.message} (got ${JSON.stringify(e.value)})`)
      .join('; ');
    throw new Error(`invalid config ${path}: ${details}`);
  }
  return config;
}
