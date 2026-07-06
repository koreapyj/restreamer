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
 * Atomic persistence of the switcher's autonomy state.
 *
 * Design decision: ONE JSON file holds BOTH the pushed desired doc and the
 * active-selection map:
 *
 *   { "desired": SwitcherDesiredState | null,
 *     "selections": { "<slug>": { "upstreamId", "switchedAt", "reason" } } }
 *
 * A single tmp+rename write keeps the pair consistent — a selection is only
 * meaningful relative to the desired doc that defines its upstreams, and two
 * files could be torn apart by a crash between writes. The file lives at
 * `stateFile` (default /var/lib/switcher/desired.json, PVC-backed on k8s).
 *
 * Corrupt or schema-invalid file → renamed aside as `<stateFile>.corrupt-<ts>`
 * and the switcher boots empty (desiredRevision: null), so the controller's
 * status poll re-pushes immediately instead of the pod crash-looping.
 */

import { mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { SwitcherDesiredState, SwitchReason } from '../contract/v1.js';
import { atomicWrite } from '../util/atomicWrite.js';
import type { Logger, SelectionMap } from './stitch.js';

export interface PersistedSwitcherState {
  desired: SwitcherDesiredState | null;
  selections: SelectionMap;
}

const PersistedSchema = Type.Object({
  desired: Type.Union([SwitcherDesiredState, Type.Null()]),
  selections: Type.Record(
    Type.String(),
    Type.Object({
      upstreamId: Type.String(),
      /** ISO 8601 */
      switchedAt: Type.String(),
      reason: SwitchReason,
    }),
  ),
});

const EMPTY: PersistedSwitcherState = { desired: null, selections: {} };

export class SwitcherStore {
  /** serializes writes: concurrent save() calls (API handler + failover hook) must never interleave or land out of order */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger = console,
  ) {}

  /**
   * Missing file → empty state. Corrupt (unparseable / schema-invalid) file →
   * moved aside, empty state returned.
   */
  async load(): Promise<PersistedSwitcherState> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY, selections: {} };
      throw err;
    }
    try {
      const doc: unknown = JSON.parse(text);
      if (!Value.Check(PersistedSchema, doc)) {
        const first = [...Value.Errors(PersistedSchema, doc)][0];
        throw new Error(`state file does not match schema${first ? ` (${first.path}: ${first.message})` : ''}`);
      }
      return doc;
    } catch (err) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const aside = `${this.filePath}.corrupt-${ts}`;
      await rename(this.filePath, aside).catch(() => undefined);
      this.logger.error(
        `state file ${this.filePath} is corrupt (${err instanceof Error ? err.message : String(err)}); ` +
          `moved aside to ${aside} — starting empty, waiting for a controller push`,
      );
      return { ...EMPTY, selections: {} };
    }
  }

  /** tmp+rename via atomicWrite — readers (and crashes) never observe a partial doc. */
  async save(desired: SwitcherDesiredState | null, selections: SelectionMap): Promise<void> {
    const doc: PersistedSwitcherState = { desired, selections };
    const task = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await atomicWrite(this.filePath, `${JSON.stringify(doc, null, 2)}\n`);
    });
    this.writeQueue = task.catch(() => undefined);
    return task;
  }
}
