/*
 * PatProbe: incremental PAT parsing over hand-crafted 188-byte TS packets —
 * sync acquisition with resync tolerance, single/multi-program PATs, NIT
 * skipping, split feeds, non-PAT PIDs, the single-packet-PAT limitation, and
 * pickProgram's lowest-wins policy.
 */

import { describe, expect, it, vi } from 'vitest';
import { PatProbe, pickProgram } from '../src/pipeline/patProbe.js';
import { nullPacket, patPacket, patStream, tsPacket } from './support/tsFixtures.js';

describe('PatProbe.feed', () => {
  it('parses a single-program PAT (program number and PMT PID)', () => {
    const probe = new PatProbe();
    expect(probe.feed(patStream([{ programNumber: 1064, pmtPid: 0x1f0 }]))).toEqual([
      { programNumber: 1064, pmtPid: 0x1f0 },
    ]);
  });

  it('returns every program of a multi-program PAT in loop order', () => {
    const probe = new PatProbe();
    const programs = [
      { programNumber: 2064, pmtPid: 0x2f0 },
      { programNumber: 1032, pmtPid: 0x1f0 },
      { programNumber: 3096, pmtPid: 0x3f0 },
    ];
    expect(probe.feed(patStream(programs))).toEqual(programs);
  });

  it('skips program_number 0 (network/NIT) entries', () => {
    const probe = new PatProbe();
    const result = probe.feed(
      patStream([
        { programNumber: 0, pmtPid: 0x0010 }, // NIT
        { programNumber: 205, pmtPid: 0x0111 },
      ]),
    );
    expect(result).toEqual([{ programNumber: 205, pmtPid: 0x0111 }]);
  });

  it('keeps scanning past a PAT that only lists the NIT', () => {
    const probe = new PatProbe();
    expect(probe.feed(patStream([{ programNumber: 0, pmtPid: 0x0010 }]))).toBeNull();
    expect(probe.feed(patStream([{ programNumber: 7, pmtPid: 0x0100 }]))).toEqual([
      { programNumber: 7, pmtPid: 0x0100 },
    ]);
  });

  it('handles a PAT split across two feed() calls at an arbitrary byte boundary', () => {
    const stream = patStream([{ programNumber: 1064, pmtPid: 0x1f0 }]);
    const probe = new PatProbe();
    expect(probe.feed(stream.subarray(0, 100))).toBeNull(); // mid-PAT-packet split
    expect(probe.feed(stream.subarray(100))).toEqual([{ programNumber: 1064, pmtPid: 0x1f0 }]);
  });

  it('withholds a fully-fed PAT until sync is confirmed by two more packets', () => {
    const stream = patStream([{ programNumber: 42, pmtPid: 0x0042 }]);
    const probe = new PatProbe();
    // whole PAT packet + second sync byte present, third packet still missing
    expect(probe.feed(stream.subarray(0, 189))).toBeNull();
    expect(probe.feed(stream.subarray(189))).toEqual([{ programNumber: 42, pmtPid: 0x0042 }]);
  });

  it('resyncs past leading garbage, including a decoy 0x47 that fails confirmation', () => {
    const garbage = Buffer.alloc(300, 0x00);
    garbage[10] = 0x47; // decoy: no 0x47 at +188/+376
    const probe = new PatProbe();
    const result = probe.feed(Buffer.concat([garbage, patStream([{ programNumber: 5, pmtPid: 0x0050 }])]));
    expect(result).toEqual([{ programNumber: 5, pmtPid: 0x0050 }]);
  });

  it('ignores packets on non-PAT PIDs, even section-like ones with PUSI set', () => {
    const pmtLike = tsPacket({
      pid: 0x0100,
      pusi: true,
      // pointer 0, table_id 0x02 (PMT) — must not be mistaken for a PAT
      payload: Buffer.from([0x00, 0x02, 0xb0, 0x0d, 0x04, 0x28, 0xc1, 0x00, 0x00]),
    });
    const probe = new PatProbe();
    expect(probe.feed(Buffer.concat([pmtLike, nullPacket(0), nullPacket(1), nullPacket(2)]))).toBeNull();
    expect(probe.feed(patStream([{ programNumber: 1064, pmtPid: 0x1f0 }]))).toEqual([
      { programNumber: 1064, pmtPid: 0x1f0 },
    ]);
  });

  it('skips a PAT whose section spans multiple packets (documented limitation) and keeps scanning', () => {
    // section_length 0x120 → section end far past the 188-byte packet
    const multiPacketPat = tsPacket({
      pid: 0x0000,
      pusi: true,
      payload: Buffer.from([0x00, 0x00, 0xb1, 0x20, 0x00, 0x01, 0xc1, 0x00, 0x00]),
    });
    const probe = new PatProbe();
    expect(probe.feed(Buffer.concat([multiPacketPat, nullPacket(0), nullPacket(1)]))).toBeNull();
    expect(probe.feed(patStream([{ programNumber: 9, pmtPid: 0x0090 }]))).toEqual([
      { programNumber: 9, pmtPid: 0x0090 },
    ]);
  });

  it('parses a PAT behind a non-zero pointer_field', () => {
    const probe = new PatProbe();
    const stream = Buffer.concat([
      patPacket([{ programNumber: 11, pmtPid: 0x0110 }], { pointer: 17 }),
      nullPacket(0),
      nullPacket(1),
    ]);
    expect(probe.feed(stream)).toEqual([{ programNumber: 11, pmtPid: 0x0110 }]);
  });

  it('accounts every fed byte in bytesConsumed, across feeds and after success', () => {
    const probe = new PatProbe();
    expect(probe.bytesConsumed).toBe(0);
    const garbage = Buffer.alloc(123, 0x00);
    probe.feed(garbage);
    expect(probe.bytesConsumed).toBe(123);
    const stream = patStream([{ programNumber: 1, pmtPid: 0x0100 }]);
    probe.feed(stream.subarray(0, 200));
    expect(probe.bytesConsumed).toBe(323);
    expect(probe.feed(stream.subarray(200))).toEqual([{ programNumber: 1, pmtPid: 0x0100 }]);
    expect(probe.bytesConsumed).toBe(123 + stream.length);
  });
});

describe('pickProgram', () => {
  it('returns the single program without logging', () => {
    const warn = vi.fn();
    expect(pickProgram([{ programNumber: 1064, pmtPid: 0x1f0 }], { warn }, 'at-x')).toBe(1064);
    expect(warn).not.toHaveBeenCalled();
  });

  it('picks the LOWEST program number of several and logs all candidates', () => {
    const warn = vi.fn();
    const picked = pickProgram(
      [
        { programNumber: 2064, pmtPid: 0x2f0 },
        { programNumber: 1032, pmtPid: 0x1f0 },
        { programNumber: 3096, pmtPid: 0x3f0 },
      ],
      { warn },
      'at-x',
    );
    expect(picked).toBe(1032);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]?.[0] as string;
    expect(msg).toContain('at-x');
    expect(msg).toContain('2064');
    expect(msg).toContain('1032');
    expect(msg).toContain('3096');
  });
});
