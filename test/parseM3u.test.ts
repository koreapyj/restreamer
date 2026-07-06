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

import { describe, expect, it } from 'vitest';
import { parseM3u } from '../src/sources/parseM3u.js';

describe('parseM3u', () => {
  it('parses a well-formed catalog with attributes', () => {
    const { entries, warnings } = parseM3u(
      [
        '#EXTM3U',
        '#EXTINF:-1 tvg-id="atx.jp" tvg-logo="http://logo/atx.png" tvg-chno="9.1",AT-X',
        'https://example.com/atx/index.m3u8',
        '#EXTINF:-1 tvg-id="bs11.jp" tvg-chno="11",BS11',
        'https://example.com/bs11/index.m3u8',
      ].join('\n'),
    );
    expect(warnings).toEqual([]);
    expect(entries).toEqual([
      {
        id: 'atx.jp',
        name: 'AT-X',
        url: 'https://example.com/atx/index.m3u8',
        logo: 'http://logo/atx.png',
        chno: '9.1',
      },
      { id: 'bs11.jp', name: 'BS11', url: 'https://example.com/bs11/index.m3u8', chno: '11' },
    ]);
  });

  it('omits logo when the attribute is absent or empty (chno present)', () => {
    const { entries } = parseM3u(
      ['#EXTINF:-1 tvg-id="a" tvg-logo="" tvg-chno="9",Chan A', 'http://a/'].join('\n'),
    );
    expect(entries).toEqual([{ id: 'a', name: 'Chan A', url: 'http://a/', chno: '9' }]);
    expect(entries[0]).not.toHaveProperty('logo');
  });

  it('warns and skips an entry with no tvg-chno attribute', () => {
    const { entries, warnings } = parseM3u(
      ['#EXTINF:-1 tvg-id="a",Chan A', 'http://a/'].join('\n'),
    );
    expect(entries).toEqual([]);
    expect(warnings).toEqual([
      'entry "Chan A": missing tvg-chno — skipped (entries are matched by name + tvg-chno)',
    ]);
  });

  it('warns and skips an entry with an empty tvg-chno attribute', () => {
    const { entries, warnings } = parseM3u(
      ['#EXTINF:-1 tvg-id="a" tvg-chno="",Chan A', 'http://a/'].join('\n'),
    );
    expect(entries).toEqual([]);
    expect(warnings).toEqual([
      'entry "Chan A": missing tvg-chno — skipped (entries are matched by name + tvg-chno)',
    ]);
  });

  it('passes chno through verbatim as a string ("9.10" stays "9.10")', () => {
    const { entries } = parseM3u(['#EXTINF:-1 tvg-id="x" tvg-chno="9.10",X', 'http://x/'].join('\n'));
    expect(entries[0]?.chno).toBe('9.10');
  });

  it('takes the display name after the LAST comma — commas inside attribute values never bleed in', () => {
    const { entries, warnings } = parseM3u(
      [
        '#EXTINF:-1 tvg-id="n" tvg-logo="http://logo/a,b.png" tvg-chno="1" group-title="News, World",News Channel',
        'http://n/',
      ].join('\n'),
    );
    expect(warnings).toEqual([]);
    expect(entries[0]?.name).toBe('News Channel');
    expect(entries[0]?.logo).toBe('http://logo/a,b.png');
  });

  it('truncates a display name containing a literal comma to the part after it (documented tradeoff)', () => {
    const { entries } = parseM3u(
      ['#EXTINF:-1 tvg-id="hw" tvg-chno="1",Hello, World', 'http://hw/'].join('\n'),
    );
    expect(entries[0]?.name).toBe('World');
  });

  it('derives the id from the name when tvg-id is missing or empty (slug rules)', () => {
    const { entries, warnings } = parseM3u(
      [
        '#EXTINF:-1 tvg-chno="1",AT-X HD!',
        'http://a/',
        '#EXTINF:-1 tvg-id="" tvg-chno="2",  --Foo   Bar 2--  ',
        'http://b/',
      ].join('\n'),
    );
    expect(warnings).toEqual([]);
    expect(entries.map((e) => e.id)).toEqual(['at-x-hd', 'foo-bar-2']);
  });

  it('caps derived ids at 64 chars without a trailing hyphen', () => {
    const name = `${'a'.repeat(63)} tail`;
    const { entries } = parseM3u([`#EXTINF:-1 tvg-chno="1",${name}`, 'http://long/'].join('\n'));
    const id = entries[0]?.id ?? '';
    expect(id).toBe('a'.repeat(63));
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id.endsWith('-')).toBe(false);
  });

  it('skips an entry whose id cannot be derived (non-sluggable name, no tvg-id)', () => {
    const { entries, warnings } = parseM3u(
      ['#EXTINF:-1 tvg-chno="1",日本語チャンネル', 'http://jp/'].join('\n'),
    );
    expect(entries).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/cannot derive an id .* set tvg-id/);
  });

  it('suffixes duplicate ids with -2, -3 and warns', () => {
    const { entries, warnings } = parseM3u(
      [
        '#EXTINF:-1 tvg-id="dup" tvg-chno="1",First',
        'http://1/',
        '#EXTINF:-1 tvg-id="dup" tvg-chno="2",Second',
        'http://2/',
        '#EXTINF:-1 tvg-id="dup" tvg-chno="3",Third',
        'http://3/',
      ].join('\n'),
    );
    expect(entries.map((e) => e.id)).toEqual(['dup', 'dup-2', 'dup-3']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/duplicate id "dup".*"dup-2"/);
    expect(warnings[1]).toMatch(/duplicate id "dup".*"dup-3"/);
  });

  it('suffixes duplicate DERIVED ids too (two entries slugging to the same name)', () => {
    const { entries, warnings } = parseM3u(
      [
        '#EXTINF:-1 tvg-chno="1",My Channel',
        'http://1/',
        '#EXTINF:-1 tvg-chno="2",My  Channel!',
        'http://2/',
      ].join('\n'),
    );
    expect(entries.map((e) => e.id)).toEqual(['my-channel', 'my-channel-2']);
    expect(warnings).toHaveLength(1);
  });

  it('warns and skips an #EXTINF with no following URL', () => {
    const { entries, warnings } = parseM3u(
      [
        '#EXTINF:-1 tvg-id="orphan",Orphan',
        '#EXTINF:-1 tvg-id="ok" tvg-chno="1",OK',
        'http://ok/',
        '#EXTINF:-1 tvg-id="tail-orphan",Tail',
      ].join('\n'),
    );
    expect(entries.map((e) => e.id)).toEqual(['ok']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/line 1: #EXTINF without a URL/);
    expect(warnings[1]).toMatch(/line 4: #EXTINF without a URL/);
  });

  it('warns and skips a bare URL without a preceding #EXTINF', () => {
    const { entries, warnings } = parseM3u(
      ['#EXTM3U', 'http://bare/', '#EXTINF:-1 tvg-id="ok" tvg-chno="1",OK', 'http://ok/'].join('\n'),
    );
    expect(entries.map((e) => e.id)).toEqual(['ok']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/line 2: URL without a preceding #EXTINF/);
  });

  it('warns and skips an #EXTINF with an empty display name', () => {
    const { entries, warnings } = parseM3u(['#EXTINF:-1 tvg-id="noname",', 'http://x/'].join('\n'));
    expect(entries).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no display name/);
  });

  it('ignores blank lines and unknown # directives between EXTINF and URL', () => {
    const { entries, warnings } = parseM3u(
      ['#EXTINF:-1 tvg-id="s" tvg-chno="1",Spaced', '', '#EXTGRP:anime', '  ', 'http://s/'].join('\n'),
    );
    expect(warnings).toEqual([]);
    expect(entries).toEqual([{ id: 's', name: 'Spaced', url: 'http://s/', chno: '1' }]);
  });

  it('tolerates CRLF line endings and trailing whitespace', () => {
    const { entries, warnings } = parseM3u(
      '#EXTM3U\r\n#EXTINF:-1 tvg-id="crlf" tvg-chno="12",CRLF Chan \r\nhttp://crlf/ \r\n',
    );
    expect(warnings).toEqual([]);
    expect(entries).toEqual([{ id: 'crlf', name: 'CRLF Chan', url: 'http://crlf/', chno: '12' }]);
  });

  it('returns empty entries and no warnings for an empty or header-only file', () => {
    expect(parseM3u('')).toEqual({ entries: [], warnings: [] });
    expect(parseM3u('#EXTM3U\n')).toEqual({ entries: [], warnings: [] });
  });
});
