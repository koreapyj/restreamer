/*
 * Wire-contract v1 schema tests — a realistic production-shaped desired doc
 * must validate; malformed docs must be rejected.
 */

import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  DesiredState,
  RESTREAMER_API_VERSION,
  SwitchCommand,
  SwitcherDesiredState,
  type DesiredState as DesiredStateT,
  type SwitcherDesiredState as SwitcherDesiredStateT,
} from '../src/contract/v1.js';

/** mirrors the current production at-x unit: SOURCE=channel, PID=333, MODE=ivtc */
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
          template: 'arib-hls',
          templateVersion: 1,
          video: { mode: 'ivtc', codec: 'hevc_qsv', bitrate: '3M', preset: 7 },
          audio: [
            { bitrate: '128k', volume: '5dB', language: 'jpn', name: 'Main', isDefault: true },
            { bitrate: '64k', volume: '5dB', language: 'jpn', name: 'Sub' },
          ],
          subtitles: { enabled: true, language: 'jpn' },
          thumbnail: { enabled: true },
          hls: { segmentSeconds: 5, listSize: 120 },
        },
      },
    ],
  };
}

describe('DesiredState', () => {
  it('exports apiVersion 1', () => {
    expect(RESTREAMER_API_VERSION).toBe(1);
  });

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
            template: 'arib-hls',
            templateVersion: 1,
            video: { mode: 'deinterlace' },
            audio: [{}],
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

  it('rejects more than 4 audio entries', () => {
    const doc = atXDoc();
    doc.sessions[0]!.pipeline.audio = [{}, {}, {}, {}, {}];
    expect(Value.Check(DesiredState, doc)).toBe(false);
  });

  it('rejects an empty audio array', () => {
    const doc = atXDoc();
    doc.sessions[0]!.pipeline.audio = [];
    expect(Value.Check(DesiredState, doc)).toBe(false);
  });

  it('rejects a source that is neither channelUuid nor url', () => {
    const doc = atXDoc() as unknown as { sessions: [{ source: unknown }] };
    doc.sessions[0].source = { streamProfile: 'pass' };
    expect(Value.Check(DesiredState, doc)).toBe(false);
  });

  it('rejects a missing programNumber', () => {
    const doc = atXDoc() as unknown as { sessions: [{ tsreadex: Record<string, unknown> }] };
    delete doc.sessions[0].tsreadex['programNumber'];
    expect(Value.Check(DesiredState, doc)).toBe(false);
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
