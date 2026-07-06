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

/* Hand-crafted 188-byte MPEG-TS packet fixtures for the PAT-probe tests. */

export const TS_PACKET_SIZE = 188;

export interface FixtureProgram {
  programNumber: number;
  pmtPid: number;
}

/**
 * One TS packet: header `0x47 <pusi|pidHi> <pidLo> 0x10|cc` (payload only,
 * no adaptation field), payload copied in, rest stuffed with 0xff.
 */
export function tsPacket(opts: { pid: number; pusi?: boolean; cc?: number; payload?: Buffer }): Buffer {
  const pkt = Buffer.alloc(TS_PACKET_SIZE, 0xff);
  pkt[0] = 0x47;
  pkt[1] = ((opts.pusi ?? false) ? 0x40 : 0x00) | ((opts.pid >> 8) & 0x1f);
  pkt[2] = opts.pid & 0xff;
  pkt[3] = 0x10 | ((opts.cc ?? 0) & 0x0f); // adaptation_field_control=01 (payload only)
  if (opts.payload) opts.payload.copy(pkt, 4);
  return pkt;
}

/** Null packet (PID 0x1fff) — pure sync/stuffing filler. */
export function nullPacket(cc = 0): Buffer {
  return tsPacket({ pid: 0x1fff, cc });
}

/**
 * A single-packet PAT: PID 0x0000, PUSI set, pointer_field 0, table_id 0x00,
 * the given program loop entries (program_number 0 = network/NIT), dummy CRC.
 */
export function patPacket(programs: FixtureProgram[], opts: { pointer?: number } = {}): Buffer {
  const pointer = opts.pointer ?? 0;
  const sectionLength = 5 + programs.length * 4 + 4; // fixed header rest + loop + CRC32
  const section = Buffer.alloc(3 + sectionLength);
  section[0] = 0x00; // table_id: PAT
  section[1] = 0xb0 | ((sectionLength >> 8) & 0x0f); // section_syntax_indicator, '0', reserved
  section[2] = sectionLength & 0xff;
  section[3] = 0x00; // transport_stream_id
  section[4] = 0x01;
  section[5] = 0xc1; // reserved, version 0, current_next=1
  section[6] = 0x00; // section_number
  section[7] = 0x00; // last_section_number
  let off = 8;
  for (const { programNumber, pmtPid } of programs) {
    section[off] = (programNumber >> 8) & 0xff;
    section[off + 1] = programNumber & 0xff;
    section[off + 2] = 0xe0 | ((pmtPid >> 8) & 0x1f);
    section[off + 3] = pmtPid & 0xff;
    off += 4;
  }
  section.fill(0xde, off, off + 4); // dummy CRC32 (the probe does not verify it)

  const payload = Buffer.concat([Buffer.from([pointer]), Buffer.alloc(pointer, 0xff), section]);
  return tsPacket({ pid: 0x0000, pusi: true, payload });
}

/**
 * PAT packet followed by two null packets — the minimum for the probe's
 * sync confirmation (0x47 at the candidate, +188 and +376).
 */
export function patStream(programs: FixtureProgram[]): Buffer {
  return Buffer.concat([patPacket(programs), nullPacket(0), nullPacket(1)]);
}
