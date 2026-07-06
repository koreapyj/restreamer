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
 * Pure incremental MPEG-TS PAT parser — no IO, no timers. The session layer
 * feeds it source chunks (while buffering them losslessly) until it yields
 * the PAT's program list, from which `pickProgram` derives the `tsreadex -n`
 * argument for sessions without an explicit `programNumber`.
 *
 * Sync: a candidate 0x47 offset is only trusted once 0x47 shows up again at
 * +188 for 2 consecutive packets (i.e. three in a row); alignment is dropped
 * and re-acquired whenever a packet boundary stops starting with 0x47.
 *
 * LIMITATION: only single-packet PAT sections are parsed. A PAT whose section
 * spans multiple TS packets (section_length reaching past the packet end, or
 * a PID-0 packet without payload_unit_start_indicator) is skipped and
 * scanning continues. Real broadcast muxes carry the PAT in one packet; the
 * caller's byte/time bounds turn a never-parsable stream into a clean error.
 */

export interface PatProgram {
  programNumber: number;
  pmtPid: number;
}

const PACKET_SIZE = 188;
/** bytes needed past a sync candidate to confirm alignment (2 more sync bytes) */
const SYNC_CONFIRM_SPAN = 2 * PACKET_SIZE;

export class PatProbe {
  private buf: Buffer = Buffer.alloc(0);
  private aligned = false;
  private totalFed = 0;

  /** total bytes handed to feed() so far — the caller's probe-size bound */
  get bytesConsumed(): number {
    return this.totalFed;
  }

  /**
   * Feed the next source chunk. Returns the PAT's program list (network/NIT
   * entries with program_number 0 excluded) as soon as a complete PAT section
   * has been seen, otherwise null — keep feeding.
   */
  feed(chunk: Buffer): PatProgram[] | null {
    this.totalFed += chunk.length;
    this.buf = this.buf.length > 0 ? Buffer.concat([this.buf, chunk]) : chunk;

    for (;;) {
      if (!this.aligned) {
        const idx = this.findSync();
        if (idx < 0) {
          this.trimDeadBytes();
          return null;
        }
        this.buf = this.buf.subarray(idx);
        this.aligned = true;
      }
      while (this.buf.length >= PACKET_SIZE) {
        if (this.buf[0] !== 0x47) {
          // lost alignment mid-stream — resync from the next byte
          this.aligned = false;
          this.buf = this.buf.subarray(1);
          break;
        }
        const programs = parsePatPacket(this.buf);
        this.buf = this.buf.subarray(PACKET_SIZE);
        if (programs !== null && programs.length > 0) return programs;
      }
      if (this.aligned) return null; // aligned but out of whole packets — need more data
    }
  }

  /**
   * Candidate offset i is trusted only when buf[i], buf[i+188] and buf[i+376]
   * are all 0x47; returns -1 when no confirmable candidate exists yet.
   */
  private findSync(): number {
    for (let i = 0; i + SYNC_CONFIRM_SPAN < this.buf.length; i++) {
      if (
        this.buf[i] === 0x47 &&
        this.buf[i + PACKET_SIZE] === 0x47 &&
        this.buf[i + SYNC_CONFIRM_SPAN] === 0x47
      ) {
        return i;
      }
    }
    return -1;
  }

  /**
   * While unaligned, every offset whose confirmation window fits entirely in
   * the buffer has already been evaluated and rejected — only the tail that
   * could still be confirmed by future bytes needs to be kept.
   */
  private trimDeadBytes(): void {
    if (this.buf.length > SYNC_CONFIRM_SPAN) {
      this.buf = this.buf.subarray(this.buf.length - SYNC_CONFIRM_SPAN);
    }
  }
}

/** Parse one 188-byte packet; program list when it carries a whole PAT, else null. */
function parsePatPacket(pkt: Buffer): PatProgram[] | null {
  const b1 = pkt[1] as number;
  const b3 = pkt[3] as number;
  if ((b1 & 0x80) !== 0) return null; // transport_error_indicator
  const pid = ((b1 & 0x1f) << 8) | (pkt[2] as number);
  if (pid !== 0x0000) return null;
  if ((b1 & 0x40) === 0) return null; // no payload_unit_start — PAT continuation (unsupported)
  const afc = (b3 >> 4) & 0x03;
  if ((afc & 0x01) === 0) return null; // no payload
  let off = 4;
  if ((afc & 0x02) !== 0) {
    off = 5 + (pkt[4] as number); // skip adaptation field
    if (off >= PACKET_SIZE) return null;
  }
  off += 1 + (pkt[off] as number); // pointer_field
  if (off + 3 > PACKET_SIZE) return null;
  if (pkt[off] !== 0x00) return null; // table_id must be PAT
  const sectionLength = (((pkt[off + 1] as number) & 0x0f) << 8) | (pkt[off + 2] as number);
  const sectionEnd = off + 3 + sectionLength;
  if (sectionEnd > PACKET_SIZE) return null; // multi-packet PAT — see header LIMITATION
  if (sectionLength < 9) return null; // 5 fixed header bytes + CRC32 minimum

  const programs: PatProgram[] = [];
  const loopEnd = sectionEnd - 4; // exclude CRC32
  for (let p = off + 8; p + 4 <= loopEnd; p += 4) {
    const programNumber = ((pkt[p] as number) << 8) | (pkt[p + 1] as number);
    if (programNumber === 0) continue; // network (NIT) entry
    programs.push({
      programNumber,
      pmtPid: (((pkt[p + 2] as number) & 0x1f) << 8) | (pkt[p + 3] as number),
    });
  }
  return programs;
}

/**
 * Choose the program to feed `tsreadex -n`: a single program is taken as-is;
 * with several, the LOWEST program number wins and all candidates are logged.
 */
export function pickProgram(
  programs: PatProgram[],
  logger: { warn(msg: string): void },
  sessionName: string,
): number {
  if (programs.length === 0) throw new Error('pickProgram: empty program list');
  let lowest = programs[0] as PatProgram;
  for (const program of programs) {
    if (program.programNumber < lowest.programNumber) lowest = program;
  }
  if (programs.length > 1) {
    const all = programs.map((p) => p.programNumber).join(', ');
    logger.warn(
      `[${sessionName}] PAT lists ${programs.length} programs (${all}) — picking the lowest: ${lowest.programNumber}`,
    );
  }
  return lowest.programNumber;
}
