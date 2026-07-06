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
 * Atomic JSON persistence of the accepted desired doc — the autonomy piece:
 * the daemon keeps supervising across its own restarts and controller
 * outages by reloading this file at startup.
 */

import { mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { DesiredState } from '../contract/v1.js';
import { atomicWrite } from '../util/atomicWrite.js';
import type { Logger } from '../supervise/types.js';

export class DesiredStore {
  constructor(
    private readonly filePath: string,
    private readonly logger: Logger = console,
  ) {}

  /**
   * Missing file → null. Corrupt (unparseable / non-object) JSON → the file
   * is renamed aside as `<stateFile>.corrupt-<ts>` and null is returned, so
   * the daemon comes up empty instead of crash-looping.
   */
  async load(): Promise<DesiredState | null> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    try {
      const doc: unknown = JSON.parse(text);
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new Error('state file is not a JSON object');
      }
      return doc as DesiredState;
    } catch (err) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const aside = `${this.filePath}.corrupt-${ts}`;
      await rename(this.filePath, aside).catch(() => undefined);
      this.logger.error(
        `state file ${this.filePath} is corrupt (${err instanceof Error ? err.message : String(err)}); ` +
          `moved aside to ${aside} — starting with no desired state, waiting for a controller push`,
      );
      return null;
    }
  }

  /** tmp+rename via atomicWrite — readers (and crashes) never observe a partial doc. */
  async save(doc: DesiredState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await atomicWrite(this.filePath, `${JSON.stringify(doc, null, 2)}\n`);
  }
}
