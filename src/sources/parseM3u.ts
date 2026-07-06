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
 * Tolerant M3U parser for the local external-sources catalog (`sourcesM3u`).
 *
 * Per `#EXTINF:` line: `attr="value"` pairs are extracted with a regex, the
 * display name is the text after the LAST comma (so commas inside quoted
 * attribute values never bleed into the name — the accepted tradeoff is that
 * a literal comma in a display name truncates it to the part after the
 * comma), and the next non-blank non-# line is the URL. Malformed pairs
 * (EXTINF without URL, URL without EXTINF) are skipped with a warning —
 * one bad entry never poisons the catalog.
 *
 * Entry `id` is auto-assigned (like tvheadend assigns channel uuids):
 * the `tvg-id` attribute when non-empty, else a stable hash of the entry
 * URL. Identity matching uses (name, chno) — never the id; it only names
 * the entry in the API and is re-emitted as the playlist `tvg-id` when a
 * channel resolves from the catalog, so set an explicit `tvg-id` only if
 * your EPG XML is keyed by it.
 *
 * `tvg-chno` is REQUIRED: catalog entries are identity-matched by
 * (name, chno). An `#EXTINF` without a non-empty `tvg-chno` is skipped
 * with a warning.
 */

import type { SourceCatalogEntry } from '../contract/v1.js';
import { stableHash } from '../util/hash.js';

export interface ParseM3uResult {
  entries: SourceCatalogEntry[];
  /** non-fatal problems: skipped lines, duplicate ids, underivable ids */
  warnings: string[];
}

const ATTR_PATTERN = /([\w-]+)="([^"]*)"/g;

interface PendingExtinf {
  lineNo: number;
  name: string;
  attrs: Map<string, string>;
}

export function parseM3u(text: string): ParseM3uResult {
  const entries: SourceCatalogEntry[] = [];
  const warnings: string[] = [];
  let pending: PendingExtinf | null = null;

  const lines = text.split(/\r?\n/); // CRLF-tolerant

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? '';
    if (line === '') continue;
    const lineNo = i + 1;

    if (line.startsWith('#EXTINF:')) {
      if (pending) {
        warnings.push(`line ${pending.lineNo}: #EXTINF without a URL line — entry skipped`);
      }
      const attrs = new Map<string, string>();
      for (const match of line.matchAll(ATTR_PATTERN)) {
        attrs.set(match[1] as string, match[2] as string);
      }
      const lastComma = line.lastIndexOf(',');
      const name = lastComma === -1 ? '' : line.slice(lastComma + 1).trim();
      pending = { lineNo, name, attrs };
      continue;
    }

    if (line.startsWith('#')) continue; // #EXTM3U and other directives

    // a URL line
    if (!pending) {
      warnings.push(`line ${lineNo}: URL without a preceding #EXTINF — skipped`);
      continue;
    }
    const { name, attrs, lineNo: extinfLine } = pending;
    pending = null;

    if (name === '') {
      warnings.push(`line ${extinfLine}: #EXTINF has no display name — entry skipped`);
      continue;
    }

    const chno = attrs.get('tvg-chno')?.trim() ?? '';
    if (chno === '') {
      warnings.push(
        `entry ${JSON.stringify(name)}: missing tvg-chno — skipped (entries are matched by name + tvg-chno)`,
      );
      continue;
    }

    // Auto-assigned id (never used for matching): explicit tvg-id, else a
    // stable hash of the URL — deterministic across reloads, no derivation
    // failures regardless of the name's script.
    const tvgId = attrs.get('tvg-id')?.trim() ?? '';
    const id = tvgId !== '' ? tvgId : stableHash(line).slice(0, 16);

    const logo = attrs.get('tvg-logo') ?? '';
    entries.push({
      id,
      name,
      url: line,
      chno,
      ...(logo !== '' ? { logo } : {}),
    });
  }

  if (pending) {
    warnings.push(`line ${pending.lineNo}: #EXTINF without a URL line — entry skipped`);
  }

  return { entries, warnings };
}
