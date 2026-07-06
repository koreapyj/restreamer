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
 * Entry `id` = the `tvg-id` attribute when non-empty, else a slug derived
 * from the display name. SET `tvg-id` FOR ID STABILITY: the controller
 * stores the id as `source_key`, so a name-derived id breaks the link when
 * the entry is renamed. Duplicate ids get `-2`, `-3`, … suffixes (warned).
 */

import type { SourceCatalogEntry } from '../contract/v1.js';

export interface ParseM3uResult {
  entries: SourceCatalogEntry[];
  /** non-fatal problems: skipped lines, duplicate ids, underivable ids */
  warnings: string[];
}

const ATTR_PATTERN = /([\w-]+)="([^"]*)"/g;

/**
 * Slug derivation for entries without a `tvg-id` (same rules as the
 * controller's channel slugs): lowercase, runs of anything outside
 * [a-z0-9-] collapse to '-', leading/trailing '-' trimmed (so it starts
 * alphanumeric), capped at 64 chars. Returns '' when nothing sluggable
 * remains (e.g. a name of only symbols or non-Latin characters).
 */
function deriveSlug(name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  if (slug.length > 64) slug = slug.slice(0, 64).replace(/-+$/, '');
  return slug;
}

interface PendingExtinf {
  lineNo: number;
  name: string;
  attrs: Map<string, string>;
}

export function parseM3u(text: string): ParseM3uResult {
  const entries: SourceCatalogEntry[] = [];
  const warnings: string[] = [];
  const usedIds = new Set<string>();
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

    const tvgId = attrs.get('tvg-id')?.trim() ?? '';
    let id = tvgId !== '' ? tvgId : deriveSlug(name);
    if (id === '') {
      warnings.push(
        `line ${extinfLine}: cannot derive an id from name ${JSON.stringify(name)} — set tvg-id; entry skipped`,
      );
      continue;
    }
    if (usedIds.has(id)) {
      const base = id;
      for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
      warnings.push(
        `line ${extinfLine}: duplicate id ${JSON.stringify(base)} — renamed to ${JSON.stringify(id)}; set a unique tvg-id`,
      );
    }
    usedIds.add(id);

    const logo = attrs.get('tvg-logo') ?? '';
    const chno = attrs.get('tvg-chno') ?? '';
    entries.push({
      id,
      name,
      url: line,
      ...(logo !== '' ? { logo } : {}),
      ...(chno !== '' ? { chno } : {}),
    });
  }

  if (pending) {
    warnings.push(`line ${pending.lineNo}: #EXTINF without a URL line — entry skipped`);
  }

  return { entries, warnings };
}
