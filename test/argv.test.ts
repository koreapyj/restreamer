/*
 * GOLDEN TEST — argv parity with the production script
 * `.claude/ref/restreamer/restreamer.sh` (tvh_controller repo), run as
 * `restreamer at-x` with `profile.d/at-x` (PID=333, MODE=ivtc) and
 * `restreamer.conf` (SERVE_DIR=/media).
 *
 * The fixtures below are the script's `tsreadex` and `ffmpeg` command lines
 * hand-tokenized, with shell variables substituted ($PREFIX=/media,
 * $PROFILE_NAME=at-x, $PID=333, $FILTER/$GOP from the ivtc case).
 */

import { describe, expect, it } from 'vitest';
import type { DesiredSession } from '../src/contract/v1.js';
import { buildPipeline, PipelineBuildError, type BuildCtx } from '../src/pipeline/build.js';
import { getTemplate, UnknownTemplateError } from '../src/pipeline/templates/index.js';

// restreamer.sh line 12 — the ivtc FILTER, verbatim
const PROD_FILTER =
  '[0:v]split[venc][vtmb];[venc]hwmap=derive_device=opencl,ivtc_opencl,hwmap=derive_device=qsv:reverse=1[1080p];[vtmb]deinterlace_qsv,fps=1/2,hwdownload,format=nv12,scale=w=1280:h=720[thumb];[0:a:0]volume=5dB[audio0];[0:a:1]volume=5dB[audio1]';

// restreamer.sh line 34 — the var_stream_map, verbatim
const PROD_VAR_STREAM_MAP =
  'v:0,name:1080p,agroup:audio a:0,name:arib_1,agroup:audio,default:yes,language:ja a:1,name:arib_2,agroup:audio,language:en s:0,sgroup:arib,name:arib_ass,language:ja';

// restreamer.sh lines 23–35, tokenized. One DELIBERATE DEVIATION: prod passes
// `-analyzeduration 3000000` twice (line 25 and again on line 26 just before
// `-i -`); ffmpeg only honours one value, so the builder keeps a single
// occurrence (the line-25 position) and the duplicate is dropped here.
const PROD_FFMPEG_ARGV = [
  // line 23–24: ffmpeg -nostats -hide_banner -hwaccel qsv -hwaccel_output_format qsv
  '-nostats',
  '-hide_banner',
  '-hwaccel',
  'qsv',
  '-hwaccel_output_format',
  'qsv',
  // line 25
  '-analyzeduration',
  '3000000',
  '-probesize',
  '1G',
  '-start_at_zero',
  '-avoid_negative_ts',
  'disabled',
  // line 26 (duplicate -analyzeduration 3000000 dropped — see deviation note above)
  '-f',
  'mpegts',
  '-font:s',
  'WadaLabChuMaruGo2004ARIB',
  '-rw_timeout',
  '5000000',
  '-i',
  '-',
  // line 27
  '-map_metadata',
  '-1',
  '-map_chapters',
  '-1',
  '-threads',
  '1',
  '-max_interleave_delta',
  '1000000',
  '-max_muxing_queue_size',
  '2048',
  '-filter_complex',
  PROD_FILTER,
  // line 28 ($GOP=24000/1001 for ivtc, line 13)
  '-map',
  '[1080p]',
  '-c:v:0',
  'hevc_qsv',
  '-b:v:0',
  '3M',
  '-profile:v:0',
  '1',
  '-tier:v:0',
  '0',
  '-scenario:v:0',
  '4',
  '-tag:v:0',
  'hvc1',
  '-flags:v:0',
  '+cgop',
  '-g:v:0',
  '24000/1001',
  '-preset:v:0',
  '7',
  '-aspect:v:0',
  '16:9',
  // lines 29–30
  '-map',
  '[audio0]',
  '-c:a:0',
  'libfdk_aac',
  '-b:a:0',
  '128k',
  '-map',
  '[audio1]',
  '-c:a:1',
  'libfdk_aac',
  '-b:a:1',
  '64k',
  // line 31
  '-map',
  '0:s:0',
  '-c:s',
  'ass',
  '-hls_subtitle_type',
  'ass',
  // line 32
  '-f',
  'hls',
  '-hls_time',
  '5',
  '-hls_list_size',
  '120',
  '-hls_segment_filename',
  '/media/at-x/%v/%Y%m%d-%H%M%S.ts',
  '-strftime',
  '1',
  '-hls_segment_type',
  'mpegts',
  '-hls_flags',
  'delete_segments+append_list+discont_start+omit_endlist+program_date_time',
  // line 33
  '-hls_subtitle_path',
  '/media/at-x/%v/playlist.m3u8',
  '-hls_subtitle_segment_filename',
  '/media/at-x/%v/%Y%m%d-%H%M%S.ass',
  // line 34
  '-var_stream_map',
  PROD_VAR_STREAM_MAP,
  '-master_pl_name',
  'playlist.m3u8',
  '/media/at-x/%v/stream.m3u8',
  // line 35
  '-map',
  '[thumb]',
  '-update',
  '1',
  '-atomic_writing',
  '1',
  '-y',
  '/media/at-x/thumb.jpg',
];

const ctx: BuildCtx = {
  serveDir: '/media',
  tvhBaseUrl: 'http://127.0.0.1:9981',
  defaultWeight: 100,
};

/** production at-x: MODE=ivtc, PID=333, everything else contract defaults */
function atXSession(): DesiredSession {
  return {
    name: 'at-x',
    source: { channelUuid: 'uuid-at-x' },
    tsreadex: { programNumber: 333 },
    pipeline: {
      template: 'arib-hls',
      templateVersion: 1,
      video: { mode: 'ivtc' },
      audio: [{}, {}],
    },
  };
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

describe('golden: production at-x argv parity', () => {
  const built = buildPipeline(atXSession(), ctx);

  it('reproduces the production tsreadex argv', () => {
    // restreamer.sh line 23: tsreadex -n $PID -a 13 -b 7 -c 5 -u 2 -
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

  it('reproduces the production ffmpeg argv token-for-token', () => {
    expect(built.ffmpegArgv).toEqual(PROD_FFMPEG_ARGV);
  });

  it('resolves outDir under serveDir', () => {
    expect(built.outDir).toBe('/media/at-x');
  });

  it('builds the tvh source URL with the pass profile and default weight', () => {
    expect(built.sourceUrl).toBe('http://127.0.0.1:9981/stream/channel/uuid-at-x?profile=pass&weight=100');
  });

  it('appends -progress pipe:3 at the end when ctx.progress is set', () => {
    const withProgress = buildPipeline(atXSession(), { ...ctx, progress: true });
    expect(withProgress.ffmpegArgv).toEqual([...PROD_FFMPEG_ARGV, '-progress', 'pipe:3']);
  });
});

describe('video modes', () => {
  it('deinterlace: prod filter chain and GOP 30000/1001', () => {
    const session = atXSession();
    session.pipeline.video.mode = 'deinterlace';
    const argv = buildPipeline(session, ctx).ffmpegArgv;
    // restreamer.sh lines 16–17 (the *) case)
    expect(argValue(argv, '-filter_complex')).toBe(
      '[0:v]vpp_qsv=deinterlace=advanced:rate=frame,split[1080p][tmpv];[tmpv]fps=1/2,scale=w=1280:h=720[thumb];[0:a:0]volume=5dB[audio0];[0:a:1]volume=5dB[audio1]',
    );
    expect(argValue(argv, '-g:v:0')).toBe('30000/1001');
  });

  it('none: split without deinterlace, sw scale after hwdownload, GOP 30000/1001', () => {
    const session = atXSession();
    session.pipeline.video.mode = 'none';
    const argv = buildPipeline(session, ctx).ffmpegArgv;
    expect(argValue(argv, '-filter_complex')).toBe(
      '[0:v]split[1080p][tmpv];[tmpv]fps=1/2,hwdownload,format=nv12,scale=w=1280:h=720[thumb];[0:a:0]volume=5dB[audio0];[0:a:1]volume=5dB[audio1]',
    );
    expect(argValue(argv, '-g:v:0')).toBe('30000/1001');
  });

  it('explicit gop overrides the mode default', () => {
    const session = atXSession();
    session.pipeline.video.gop = '60000/1001';
    expect(argValue(buildPipeline(session, ctx).ffmpegArgv, '-g:v:0')).toBe('60000/1001');
  });
});

describe('audio', () => {
  it('single audio entry: one filter label, one map, prod-shaped var_stream_map', () => {
    const session = atXSession();
    session.pipeline.audio = [{}];
    const argv = buildPipeline(session, ctx).ffmpegArgv;
    expect(argValue(argv, '-filter_complex')).toContain(';[0:a:0]volume=5dB[audio0]');
    expect(argValue(argv, '-filter_complex')).not.toContain('audio1');
    expect(argv).not.toContain('[audio1]');
    expect(argValue(argv, '-var_stream_map')).toBe(
      'v:0,name:1080p,agroup:audio a:0,name:arib_1,agroup:audio,default:yes,language:ja s:0,sgroup:arib,name:arib_ass,language:ja',
    );
    expect(argValue(argv, '-b:a:0')).toBe('128k');
  });

  it('third entry gets 64k, name arib_3 and no language attribute', () => {
    const session = atXSession();
    session.pipeline.audio = [{}, {}, {}];
    const argv = buildPipeline(session, ctx).ffmpegArgv;
    expect(argValue(argv, '-b:a:2')).toBe('64k');
    expect(argValue(argv, '-var_stream_map')).toContain(' a:2,name:arib_3,agroup:audio ');
    expect(argValue(argv, '-var_stream_map')).not.toContain('a:2,name:arib_3,agroup:audio,language');
  });

  it("volume 'none' keeps the label via anull without a gain stage", () => {
    const session = atXSession();
    session.pipeline.audio = [{ volume: 'none' }, {}];
    const filter = argValue(buildPipeline(session, ctx).ffmpegArgv, '-filter_complex')!;
    expect(filter).toContain('[0:a:0]anull[audio0]');
    expect(filter).toContain('[0:a:1]volume=5dB[audio1]');
  });

  it('per-entry overrides flow into bitrate, rendition name/language/default', () => {
    const session = atXSession();
    session.pipeline.audio = [{ bitrate: '192k', name: 'main', language: 'ja' }, { isDefault: true }];
    const argv = buildPipeline(session, ctx).ffmpegArgv;
    expect(argValue(argv, '-b:a:0')).toBe('192k');
    expect(argValue(argv, '-var_stream_map')).toBe(
      'v:0,name:1080p,agroup:audio a:0,name:main,agroup:audio,default:yes,language:ja a:1,name:arib_2,agroup:audio,default:yes,language:en s:0,sgroup:arib,name:arib_ass,language:ja',
    );
  });
});

describe('subtitles', () => {
  it('disabled: no s:0 mapping anywhere, no subtitle codec or hls_subtitle args', () => {
    const session = atXSession();
    session.pipeline.subtitles = { enabled: false };
    const argv = buildPipeline(session, ctx).ffmpegArgv;
    expect(argv).not.toContain('0:s:0');
    expect(argv).not.toContain('-c:s');
    expect(argv).not.toContain('-hls_subtitle_type');
    expect(argv).not.toContain('-hls_subtitle_path');
    expect(argv).not.toContain('-hls_subtitle_segment_filename');
    expect(argValue(argv, '-var_stream_map')).toBe(
      'v:0,name:1080p,agroup:audio a:0,name:arib_1,agroup:audio,default:yes,language:ja a:1,name:arib_2,agroup:audio,language:en',
    );
  });

  it('name/language overrides land in var_stream_map', () => {
    const session = atXSession();
    session.pipeline.subtitles = { enabled: true, language: 'en', name: 'captions' };
    expect(argValue(buildPipeline(session, ctx).ffmpegArgv, '-var_stream_map')).toContain(
      's:0,sgroup:arib,name:captions,language:en',
    );
  });
});

describe('thumbnail', () => {
  it('disabled: no thumb branch in the filter and no thumb output', () => {
    const session = atXSession();
    session.pipeline.thumbnail = { enabled: false };
    const argv = buildPipeline(session, ctx).ffmpegArgv;
    expect(argValue(argv, '-filter_complex')).toBe(
      '[0:v]hwmap=derive_device=opencl,ivtc_opencl,hwmap=derive_device=qsv:reverse=1[1080p];[0:a:0]volume=5dB[audio0];[0:a:1]volume=5dB[audio1]',
    );
    expect(argv).not.toContain('[thumb]');
    expect(argv).not.toContain('/media/at-x/thumb.jpg');
    expect(argv).not.toContain('-atomic_writing');
  });

  it('disabled + deinterlace: chain goes straight to [1080p]', () => {
    const session = atXSession();
    session.pipeline.video.mode = 'deinterlace';
    session.pipeline.thumbnail = { enabled: false };
    expect(argValue(buildPipeline(session, ctx).ffmpegArgv, '-filter_complex')).toBe(
      '[0:v]vpp_qsv=deinterlace=advanced:rate=frame[1080p];[0:a:0]volume=5dB[audio0];[0:a:1]volume=5dB[audio1]',
    );
  });

  it('size/interval overrides land in the thumb branch', () => {
    const session = atXSession();
    session.pipeline.thumbnail = { enabled: true, width: 640, height: 360, intervalSec: 10 };
    expect(argValue(buildPipeline(session, ctx).ffmpegArgv, '-filter_complex')).toContain(
      '[vtmb]deinterlace_qsv,fps=1/10,hwdownload,format=nv12,scale=w=640:h=360[thumb]',
    );
  });
});

describe('hls and encoder overrides', () => {
  it('hls_time / hls_list_size from params.hls', () => {
    const session = atXSession();
    session.pipeline.hls = { segmentSeconds: 2, listSize: 60 };
    const argv = buildPipeline(session, ctx).ffmpegArgv;
    expect(argValue(argv, '-hls_time')).toBe('2');
    expect(argValue(argv, '-hls_list_size')).toBe('60');
  });

  it('video bitrate and preset overrides', () => {
    const session = atXSession();
    session.pipeline.video.bitrate = '5M';
    session.pipeline.video.preset = 4;
    const argv = buildPipeline(session, ctx).ffmpegArgv;
    expect(argValue(argv, '-b:v:0')).toBe('5M');
    expect(argValue(argv, '-preset:v:0')).toBe('4');
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
    const params = { template: 'arib-hls', templateVersion: 2 } as unknown as Parameters<typeof getTemplate>[0];
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
    session.pipeline.audio = [];
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
