/*
 * Wire-contract v1 schema tests — a realistic production-shaped desired doc
 * must validate; malformed docs must be rejected.
 */

import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  DesiredState,
  RawArgvParams,
  SessionStatus,
  SourceCatalogEntry,
  SourcesResponse,
  StatusResponse,
  SwitchCommand,
  SwitcherChannel,
  SwitcherDesiredState,
  type DesiredState as DesiredStateT,
  type StatusResponse as StatusResponseT,
  type SwitcherDesiredState as SwitcherDesiredStateT,
} from '../src/contract/v1.js';
import {
  WsDemand,
  WsDoc,
  WsHelloDown,
  WsHelloUp,
  WsStatus,
  WsSwitch,
} from '../src/contract/ws1.js';

/** mirrors a production at-x unit: SOURCE=channel, PID=333, controller-rendered argv */
function atXDoc(): DesiredStateT {
  return {
    apiVersion: 1,
    revision: '3d8a1c0ffee',
    sessions: [
      {
        name: 'at-x',
        enabled: true,
        source: {
          channelUuid: '2d5c8e0a91b3f4c6d7e8f9a0b1c2d3e4',
          streamProfile: 'pass',
          weight: 100,
        },
        tsreadex: { programNumber: 333 },
        pipeline: {
          template: 'raw-argv',
          templateVersion: 1,
          ffmpegArgv: [
            '-nostats',
            '-hide_banner',
            '-i',
            '-',
            '-f',
            'hls',
            '-hls_time',
            '5',
            '-hls_list_size',
            '120',
            '-master_pl_name',
            'playlist.m3u8',
            '{OUT_DIR}/%v/stream.m3u8',
          ],
          segmentSeconds: 5,
          listSize: 120,
        },
      },
    ],
  };
}

describe('DesiredState', () => {
  it('accepts a realistic production doc (at-x)', () => {
    expect(Value.Check(DesiredState, atXDoc())).toBe(true);
  });

  it('accepts a minimal doc relying on defaults', () => {
    const doc = {
      apiVersion: 1,
      revision: 'r1',
      sessions: [
        {
          name: 'nhk-g',
          source: { channelUuid: 'abc' },
          tsreadex: { programNumber: 1024 },
          pipeline: {
            template: 'raw-argv',
            templateVersion: 1,
            ffmpegArgv: ['-i', '-', '{OUT_DIR}/%v/stream.m3u8'],
          },
        },
      ],
    };
    expect(Value.Check(DesiredState, doc)).toBe(true);
  });

  it('accepts a raw-url source (non-tvh escape hatch)', () => {
    const doc = atXDoc();
    doc.sessions[0]!.source = { url: 'http://example.local/stream.ts' };
    expect(Value.Check(DesiredState, doc)).toBe(true);
  });

  it('rejects a session name violating the pattern', () => {
    for (const bad of ['AT-X', 'at_x', '-atx', '', 'a'.repeat(65)]) {
      const doc = atXDoc();
      doc.sessions[0]!.name = bad;
      expect(Value.Check(DesiredState, doc), `name ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('rejects an unknown pipeline template', () => {
    const doc = atXDoc() as unknown as { sessions: [{ pipeline: { template: string } }] };
    doc.sessions[0].pipeline.template = 'mp4-vod';
    expect(Value.Check(DesiredState, doc)).toBe(false);
  });

  it('rejects a source that is neither channelUuid nor url', () => {
    const doc = atXDoc() as unknown as { sessions: [{ source: unknown }] };
    doc.sessions[0].source = { streamProfile: 'pass' };
    expect(Value.Check(DesiredState, doc)).toBe(false);
  });

  it('accepts a missing programNumber (daemon PAT-probes)', () => {
    const doc = atXDoc() as unknown as { sessions: [{ tsreadex: Record<string, unknown> }] };
    delete doc.sessions[0].tsreadex['programNumber'];
    expect(Value.Check(DesiredState, doc)).toBe(true);
  });

  it('rejects a wrong apiVersion', () => {
    const doc = { ...atXDoc(), apiVersion: 2 };
    expect(Value.Check(DesiredState, doc)).toBe(false);
  });

  it('fills production defaults via Value.Default', () => {
    const doc = Value.Default(DesiredState, Value.Clone(atXDoc())) as DesiredStateT;
    const session = doc.sessions[0]!;
    expect(session.tsreadex).toMatchObject({
      audio1Mode: 13,
      audio2Mode: 7,
      captionMode: 5,
      superimposeMode: 2,
    });
  });

  it('rejects a legacy arib-hls pipeline (template removed from the union)', () => {
    const doc = atXDoc() as unknown as { sessions: [{ pipeline: unknown }] };
    doc.sessions[0].pipeline = {
      template: 'arib-hls',
      templateVersion: 1,
      video: { mode: 'ivtc' },
      audio: [{}, {}],
    };
    expect(Value.Check(DesiredState, doc)).toBe(false);
    // TypeBox collapses a single-member Type.Union to the member schema, so
    // the error is the member's own template-literal mismatch; the top-level
    // 'Expected union value' shape returns once a second variant is added.
    const messages = [...Value.Errors(DesiredState, doc)].map((e) => e.message);
    expect(messages).toContain("Expected 'raw-argv'");
  });
});

describe('RawArgvParams', () => {
  function minimal(): RawArgvParams {
    return {
      template: 'raw-argv',
      templateVersion: 1,
      ffmpegArgv: ['-i', '-', '{OUT_DIR}/%v/stream.m3u8'],
    };
  }

  it('accepts a valid minimal payload', () => {
    expect(Value.Check(RawArgvParams, minimal())).toBe(true);
  });

  it('fills segmentSeconds=5 and listSize=120 via Value.Default', () => {
    const filled = Value.Default(RawArgvParams, Value.Clone(minimal())) as RawArgvParams;
    expect(filled.segmentSeconds).toBe(5);
    expect(filled.listSize).toBe(120);
  });

  it('rejects an empty ffmpegArgv', () => {
    expect(Value.Check(RawArgvParams, { ...minimal(), ffmpegArgv: [] })).toBe(false);
  });

  it('rejects an empty-string token', () => {
    expect(Value.Check(RawArgvParams, { ...minimal(), ffmpegArgv: ['-i', ''] })).toBe(false);
  });

  it('rejects templateVersion 2', () => {
    expect(Value.Check(RawArgvParams, { ...minimal(), templateVersion: 2 })).toBe(false);
  });
});

describe('SourcesResponse', () => {
  const entry = {
    id: 'louise-1',
    name: 'Louise 1',
    url: 'https://louise.example/stream?id=1',
    logo: 'https://louise.example/logo.png',
    chno: '9.1',
  };

  it('accepts a full catalog entry and a minimal one (chno required, logo optional)', () => {
    expect(Value.Check(SourceCatalogEntry, entry)).toBe(true);
    expect(Value.Check(SourceCatalogEntry, { id: 'x', name: 'X', url: 'http://x/', chno: '1' })).toBe(true);
  });

  it('rejects an entry missing url', () => {
    expect(Value.Check(SourceCatalogEntry, { id: 'x', name: 'X', chno: '1' })).toBe(false);
  });

  it('rejects an entry missing chno (entries are identity-matched by name + chno)', () => {
    expect(Value.Check(SourceCatalogEntry, { id: 'x', name: 'X', url: 'http://x/' })).toBe(false);
  });

  it('rejects an entry with an empty chno', () => {
    expect(Value.Check(SourceCatalogEntry, { id: 'x', name: 'X', url: 'http://x/', chno: '' })).toBe(false);
  });

  it('accepts a populated response and a no-catalog response', () => {
    const populated = {
      apiVersion: 1,
      catalogHash: 'abc123',
      updatedAt: '2026-07-06T00:00:00.000Z',
      entries: [entry],
      warnings: ['duplicate id louise-1 renamed to louise-1-2'],
    };
    expect(Value.Check(SourcesResponse, populated)).toBe(true);
    expect(
      Value.Check(SourcesResponse, { apiVersion: 1, catalogHash: null, updatedAt: null, entries: [] }),
    ).toBe(true);
  });

  it('rejects a response with an entry missing url', () => {
    const doc = {
      apiVersion: 1,
      catalogHash: 'abc123',
      updatedAt: null,
      entries: [{ id: 'x', name: 'X' }],
    };
    expect(Value.Check(SourcesResponse, doc)).toBe(false);
  });
});

describe('StatusResponse / SessionStatus additions', () => {
  function statusDoc(): StatusResponseT {
    return {
      apiVersion: 1,
      daemonVersion: '1.2.3',
      startedAt: '2026-07-06T00:00:00.000Z',
      uptimeSec: 60,
      capabilities: ['qsv'],
      templates: [{ id: 'raw-argv', version: 1 }],
      desiredRevision: 'r1',
      sessions: [],
    };
  }

  it('accepts sourcesHash present, null, and absent', () => {
    expect(Value.Check(StatusResponse, { ...statusDoc(), sourcesHash: 'abc123' })).toBe(true);
    expect(Value.Check(StatusResponse, { ...statusDoc(), sourcesHash: null })).toBe(true);
    expect(Value.Check(StatusResponse, statusDoc())).toBe(true);
  });

  it('accepts a session status with detectedProgramNumber', () => {
    const session = {
      name: 'at-x',
      state: 'running',
      enabled: true,
      configHash: 'deadbeef',
      restarts: 0,
      consecutiveFailures: 0,
      detectedProgramNumber: 333,
    };
    expect(Value.Check(SessionStatus, session)).toBe(true);
    expect(Value.Check(StatusResponse, { ...statusDoc(), sessions: [session] })).toBe(true);
  });
});

describe('SwitcherDesiredState', () => {
  function switcherDoc(): SwitcherDesiredStateT {
    return {
      apiVersion: 1,
      revision: 'r42',
      channels: [
        {
          slug: 'at-x',
          segmentSeconds: 5,
          upstreams: [
            { id: 'placement-1', url: 'http://node-a.local/at-x', priority: 0 },
            { id: 'placement-2', url: 'http://node-b.local/at-x', priority: 1 },
          ],
        },
      ],
    };
  }

  it('accepts a redundant-channel doc', () => {
    expect(Value.Check(SwitcherDesiredState, switcherDoc())).toBe(true);
  });

  it('rejects a channel with no upstreams', () => {
    const doc = switcherDoc();
    doc.channels[0]!.upstreams = [];
    expect(Value.Check(SwitcherDesiredState, doc)).toBe(false);
  });

  it('rejects an upstream missing priority', () => {
    const doc = switcherDoc() as unknown as { channels: [{ upstreams: [Record<string, unknown>] }] };
    delete doc.channels[0].upstreams[0]['priority'];
    expect(Value.Check(SwitcherDesiredState, doc)).toBe(false);
  });

  it('rejects a slug violating the session-name pattern', () => {
    const doc = switcherDoc();
    doc.channels[0]!.slug = 'AT-X';
    expect(Value.Check(SwitcherDesiredState, doc)).toBe(false);
  });

  it('validates the switch command body', () => {
    expect(Value.Check(SwitchCommand, { upstreamId: 'placement-2' })).toBe(true);
    expect(Value.Check(SwitchCommand, { upstreamId: '' })).toBe(false);
    expect(Value.Check(SwitchCommand, {})).toBe(false);
  });
});

describe('SwitcherChannel activeUpstreamId / onDemandIdle', () => {
  function channel(): SwitcherDesiredStateT['channels'][number] {
    return {
      slug: 'at-x',
      segmentSeconds: 5,
      upstreams: [{ id: 'placement-1', url: 'http://node-a.local/at-x', priority: 0 }],
    };
  }

  it('accepts a channel with both fields present', () => {
    expect(
      Value.Check(SwitcherChannel, { ...channel(), activeUpstreamId: 'placement-1', onDemandIdle: true }),
    ).toBe(true);
  });

  it('accepts a channel with both fields absent', () => {
    expect(Value.Check(SwitcherChannel, channel())).toBe(true);
  });
});

describe('ws1 wire messages', () => {
  it('validates WsHelloDown', () => {
    expect(Value.Check(WsHelloDown, { v: 1, type: 'hello', serverVersion: '1.2.3' })).toBe(true);
    expect(Value.Check(WsHelloDown, { v: 1, type: 'status', serverVersion: '1.2.3' })).toBe(false);
  });

  it('validates WsDoc', () => {
    const doc: SwitcherDesiredStateT = {
      apiVersion: 1,
      revision: 'r42',
      channels: [
        {
          slug: 'at-x',
          segmentSeconds: 5,
          upstreams: [{ id: 'placement-1', url: 'http://node-a.local/at-x', priority: 0 }],
        },
      ],
    };
    expect(Value.Check(WsDoc, { v: 1, type: 'doc', doc })).toBe(true);
    expect(Value.Check(WsDoc, { v: 1, type: 'doc' })).toBe(false);
  });

  it('validates WsSwitch', () => {
    expect(Value.Check(WsSwitch, { v: 1, type: 'switch', slug: 'at-x', upstreamId: 'placement-2' })).toBe(
      true,
    );
    expect(Value.Check(WsSwitch, { v: 1, type: 'switch', slug: 'at-x' })).toBe(false);
  });

  it('validates WsHelloUp', () => {
    expect(
      Value.Check(WsHelloUp, {
        v: 1,
        type: 'hello',
        switcherVersion: '1.2.3',
        startedAt: '2026-07-06T00:00:00.000Z',
      }),
    ).toBe(true);
    expect(Value.Check(WsHelloUp, { v: 1, type: 'hello', switcherVersion: '1.2.3' })).toBe(false);
  });

  it('validates WsStatus', () => {
    expect(Value.Check(WsStatus, { v: 1, type: 'status', desiredRevision: 'r42', channels: [] })).toBe(
      true,
    );
    expect(Value.Check(WsStatus, { v: 1, type: 'status', desiredRevision: null, channels: [] })).toBe(true);
    expect(Value.Check(WsStatus, { v: 1, type: 'status', channels: [] })).toBe(false);
  });

  it('validates WsDemand', () => {
    expect(
      Value.Check(WsDemand, {
        v: 1,
        type: 'demand',
        events: [{ slug: 'at-x', kind: 'master', at: '2026-07-06T00:00:00.000Z' }],
      }),
    ).toBe(true);
    expect(
      Value.Check(WsDemand, {
        v: 1,
        type: 'demand',
        events: [{ slug: 'at-x', kind: 'bogus', at: '2026-07-06T00:00:00.000Z' }],
      }),
    ).toBe(false);
  });
});
