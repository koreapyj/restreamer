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

/*
 * SourcesCatalog — in-memory view of the local `sourcesM3u` file, served as
 * `GET /v1/sources` and fingerprinted into `/v1/status.sourcesHash`.
 *
 * The file is re-read on an mtime POLL (5s, unref'd) rather than fs.watch:
 * polling survives the rename-replace editors and provisioning tools use,
 * and is trivially testable with injected fs/timers. A read/parse failure
 * keeps the last good catalog (plus an explanatory warning) — a half-written
 * or briefly missing file must never blank out the controller's view.
 */

import fsPromises from 'node:fs/promises';
import type { SourceCatalogEntry, SourcesResponse } from '../contract/v1.js';
import { stableHash } from '../util/hash.js';
import { parseM3u } from './parseM3u.js';

const POLL_INTERVAL_MS = 5_000;

/** Filesystem surface the catalog needs (satisfied by node:fs/promises). */
export interface CatalogFs {
  stat(path: string): Promise<{ mtimeMs: number }>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
}

/** Timer seam; the real setInterval handle is unref'd so the daemon can exit. */
export interface CatalogTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

interface CatalogLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface SourcesCatalogDeps {
  fs?: CatalogFs;
  timers?: CatalogTimers;
  logger?: CatalogLogger;
}

export class SourcesCatalog {
  private readonly path: string | null;
  private readonly fs: CatalogFs;
  private readonly timers: CatalogTimers;
  private readonly logger: CatalogLogger;

  private entries: SourceCatalogEntry[] = [];
  private warnings: string[] = [];
  private catalogHash: string | null = null;
  private updatedAt: string | null = null;

  /** mtime of the last read attempt that reached parse (skip unchanged files) */
  private lastMtimeMs: number | null = null;
  /** last failure message, to log each distinct failure once */
  private lastFailure: string | null = null;
  /** warnings of the last GOOD parse — failures append to these, not to themselves */
  private lastGoodWarnings: string[] = [];

  private interval: unknown = null;
  private polling = false;

  constructor(path: string | null, deps: SourcesCatalogDeps = {}) {
    this.path = path;
    this.fs = deps.fs ?? fsPromises;
    this.timers = deps.timers ?? { setInterval, clearInterval };
    this.logger = deps.logger ?? console;
  }

  /** fingerprint for /v1/status; null = no sourcesM3u configured */
  get hash(): string | null {
    return this.catalogHash;
  }

  /**
   * Immediate first load, then the 5s mtime poll. With a null path this is a
   * no-op: the catalog stays permanently `{catalogHash: null, entries: []}`.
   */
  async start(): Promise<void> {
    if (this.path === null) return;
    await this.poll();
    const handle = this.timers.setInterval(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
    (handle as { unref?: () => unknown } | null)?.unref?.();
    this.interval = handle;
  }

  stop(): void {
    if (this.interval !== null) {
      this.timers.clearInterval(this.interval);
      this.interval = null;
    }
  }

  snapshot(): SourcesResponse {
    return {
      apiVersion: 1,
      catalogHash: this.catalogHash,
      updatedAt: this.updatedAt,
      entries: this.entries,
      ...(this.warnings.length > 0 ? { warnings: this.warnings } : {}),
    };
  }

  private async poll(): Promise<void> {
    if (this.path === null || this.polling) return;
    this.polling = true;
    try {
      let mtimeMs: number;
      try {
        mtimeMs = (await this.fs.stat(this.path)).mtimeMs;
      } catch (err) {
        this.fail(`cannot stat sources catalog ${this.path}: ${message(err)}`);
        return;
      }
      if (mtimeMs === this.lastMtimeMs) return; // unchanged — no re-read

      let text: string;
      try {
        text = await this.fs.readFile(this.path, 'utf8');
      } catch (err) {
        this.fail(`cannot read sources catalog ${this.path}: ${message(err)}`);
        return;
      }

      const { entries, warnings } = parseM3u(text);
      this.entries = entries;
      this.lastGoodWarnings = warnings;
      this.warnings = warnings;
      this.catalogHash = stableHash(entries);
      this.updatedAt = new Date(mtimeMs).toISOString();
      this.lastMtimeMs = mtimeMs;
      this.lastFailure = null;
      this.logger.info(
        `[sources] loaded ${entries.length} entries from ${this.path}` +
          (warnings.length > 0 ? ` (${warnings.length} warnings)` : ''),
      );
    } finally {
      this.polling = false;
    }
  }

  /** keep the last good catalog; surface the failure as a warning (once per distinct message) */
  private fail(msg: string): void {
    // recomputed from the last good parse each time — never grows unboundedly
    this.warnings = [...this.lastGoodWarnings, msg];
    if (msg !== this.lastFailure) {
      this.lastFailure = msg;
      this.logger.warn(`[sources] ${msg} — keeping the last good catalog`);
    }
    // forget the mtime so recovery re-reads even if the mtime didn't change
    this.lastMtimeMs = null;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
