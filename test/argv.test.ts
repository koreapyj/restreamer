/*
 * buildPipeline (template-agnostic): tsreadex argv construction, source-URL
 * resolution, outDir derivation, progress-channel append, and rejection
 * paths. The argv content itself is controller-rendered (raw-argv) — its
 * golden test lives in the controller repo; {OUT_DIR} substitution mechanics
 * are covered in rawArgv.test.ts.
 */

import { describe, expect, it } from 'vitest';
import type { DesiredSession } from '../src/contract/v1.js';
import { buildPipeline, PipelineBuildError, type BuildCtx } from '../src/pipeline/build.js';
import { getTemplate, UnknownTemplateError } from '../src/pipeline/templates/index.js';

const RAW_ARGV = ['-i', '-', '-f', 'hls', '{OUT_DIR}/%v/stream.m3u8'];

const ctx: BuildCtx = {
  serveDir: '/media',
  tvhBaseUrl: 'http://127.0.0.1:9981',
  defaultWeight: 100,
};

function atXSession(): DesiredSession {
  return {
    name: 'at-x',
    source: { channelUuid: 'uuid-at-x' },
    tsreadex: { programNumber: 333 },
    pipeline: {
      template: 'raw-argv',
      templateVersion: 1,
      ffmpegArgv: [...RAW_ARGV],
    },
  };
}

describe('buildPipeline', () => {
  const built = buildPipeline(atXSession(), ctx);

  it('builds the production tsreadex argv from TsreadexParams defaults', () => {
    expect(built.tsreadexArgv).toEqual(['-n', '333', '-a', '13', '-b', '7', '-c', '5', '-u', '2', '-']);
  });

  it('omits -n when programNumber is absent (supervisor PAT-probes and prepends it)', () => {
    const session = atXSession();
    session.tsreadex = {};
    const withoutSid = buildPipeline(session, ctx);
    expect(withoutSid.tsreadexArgv).toEqual(['-a', '13', '-b', '7', '-c', '5', '-u', '2', '-']);
    expect(withoutSid.needsProgramNumber).toBe(true);
  });

  it('sets needsProgramNumber false when programNumber is explicit', () => {
    expect(built.needsProgramNumber).toBe(false);
  });

  it('resolves outDir under serveDir and substitutes it into the argv', () => {
    expect(built.outDir).toBe('/media/at-x');
    expect(built.ffmpegArgv).toEqual(['-i', '-', '-f', 'hls', '/media/at-x/%v/stream.m3u8']);
  });

  it('builds the tvh source URL with the pass profile and default weight', () => {
    expect(built.sourceUrl).toBe('http://127.0.0.1:9981/stream/channel/uuid-at-x?profile=pass&weight=100');
  });

  it('appends -progress pipe:3 at the end when ctx.progress is set', () => {
    const withProgress = buildPipeline(atXSession(), { ...ctx, progress: true });
    expect(withProgress.ffmpegArgv).toEqual([
      '-i',
      '-',
      '-f',
      'hls',
      '/media/at-x/%v/stream.m3u8',
      '-progress',
      'pipe:3',
    ]);
  });
});

describe('source resolution', () => {
  it('url source passes through verbatim', () => {
    const session = atXSession();
    session.source = { url: 'http://example.local/stream.ts?token=x' };
    expect(buildPipeline(session, ctx).sourceUrl).toBe('http://example.local/stream.ts?token=x');
  });

  it('explicit streamProfile and weight override the defaults', () => {
    const session = atXSession();
    session.source = { channelUuid: 'u1', streamProfile: 'htsp', weight: 250 };
    expect(buildPipeline(session, ctx).sourceUrl).toBe(
      'http://127.0.0.1:9981/stream/channel/u1?profile=htsp&weight=250',
    );
  });

  it('missing weight falls back to ctx.defaultWeight', () => {
    const session = atXSession();
    session.source = { channelUuid: 'u1' };
    expect(buildPipeline(session, { ...ctx, defaultWeight: 42 }).sourceUrl).toBe(
      'http://127.0.0.1:9981/stream/channel/u1?profile=pass&weight=42',
    );
  });

  it('tvhBaseUrl: null rejects a tvh-source session with a clear message', () => {
    const session = atXSession();
    session.source = { channelUuid: 'u1' };
    expect(() => buildPipeline(session, { ...ctx, tvhBaseUrl: null })).toThrow(
      'session "at-x": tvheadend source requires tvhBaseUrl, but this daemon has tvhBaseUrl: null (external sources only)',
    );
    expect(() => buildPipeline(session, { ...ctx, tvhBaseUrl: null })).toThrow(PipelineBuildError);
  });

  it('tvhBaseUrl: null still builds a url-source session fine', () => {
    const session = atXSession();
    session.source = { url: 'http://example.local/stream.ts?token=x' };
    expect(buildPipeline(session, { ...ctx, tvhBaseUrl: null }).sourceUrl).toBe(
      'http://example.local/stream.ts?token=x',
    );
  });
});

describe('rejection', () => {
  it('getTemplate rejects an unknown template id', () => {
    const params = { template: 'mp4-vod', templateVersion: 1 } as unknown as Parameters<typeof getTemplate>[0];
    expect(() => getTemplate(params)).toThrow(UnknownTemplateError);
  });

  it('getTemplate rejects an unknown template version', () => {
    const params = { template: 'raw-argv', templateVersion: 2 } as unknown as Parameters<typeof getTemplate>[0];
    expect(() => getTemplate(params)).toThrow(UnknownTemplateError);
  });

  it('buildPipeline rejects an unknown template via schema validation', () => {
    const session = atXSession() as unknown as { pipeline: { template: string } };
    session.pipeline.template = 'mp4-vod';
    expect(() => buildPipeline(session as unknown as DesiredSession, ctx)).toThrow(PipelineBuildError);
  });

  it('buildPipeline rejects an invalid session with details', () => {
    const session = atXSession();
    session.name = 'AT-X'; // violates the session-name pattern
    session.pipeline.ffmpegArgv = []; // violates minItems: 1
    let caught: unknown;
    try {
      buildPipeline(session, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PipelineBuildError);
    const details = (caught as PipelineBuildError).details.join('\n');
    expect(details).toContain('/name');
    expect(details).toContain('/pipeline');
  });

  it('buildPipeline does not mutate its input', () => {
    const session = atXSession();
    const snapshot = JSON.parse(JSON.stringify(session)) as unknown;
    buildPipeline(session, ctx);
    expect(session).toEqual(snapshot);
  });
});
