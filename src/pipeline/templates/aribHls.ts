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
 * 'arib-hls' v1 — the production pipeline: MPEG-TS in (via tsreadex on stdin),
 * QSV HEVC + libfdk_aac + ARIB→ASS subtitles + thumbnail out, browser-playable
 * HLS. Reproduces the legacy `restreamer.sh` ffmpeg command token-for-token
 * for production-default params, with two deliberate deviations:
 *
 *  1. the duplicated `-analyzeduration 3000000` (prod passes it twice; the
 *     second occurrence is redundant — one is kept, in the first position),
 *  2. `-progress pipe:3` is appended when ctx.progress is set (the session
 *     layer's only argv addition vs prod).
 *
 * All generated paths use forward slashes — the target runtime is Linux.
 */

import { AribHlsParams } from '../../contract/v1.js';
import type { PipelineTemplate, TemplateCtx } from './index.js';

/** software-deinterlace + inverse-telecine chain running on OpenCL, frames mapped back to QSV for the encoder */
const IVTC_CHAIN = 'hwmap=derive_device=opencl,ivtc_opencl,hwmap=derive_device=qsv:reverse=1';

/** audio bitrate default is index-dependent (see contract note on AribHlsAudio) */
function defaultAudioBitrate(index: number): string {
  return index === 0 ? '128k' : '64k';
}

/** rendition LANGUAGE default: prod labels the first two ARIB audio tracks ja/en; further tracks carry no language */
function defaultAudioLanguage(index: number): string | undefined {
  if (index === 0) return 'ja';
  if (index === 1) return 'en';
  return undefined;
}

/** `[0:a:<i>]volume=<vol>[audio<i>]` per entry; volume 'none' keeps the label without a gain stage */
function audioFilters(params: AribHlsParams): string {
  return params.audio
    .map((a, i) => {
      const volume = a.volume ?? '5dB';
      const filter = volume === 'none' ? 'anull' : `volume=${volume}`;
      return `[0:a:${i}]${filter}[audio${i}]`;
    })
    .join(';');
}

function buildFilterComplex(params: AribHlsParams, thumbEnabled: boolean): string {
  const width = params.thumbnail?.width ?? 1280;
  const height = params.thumbnail?.height ?? 720;
  const interval = params.thumbnail?.intervalSec ?? 2;
  const thumbScale = `scale=w=${width}:h=${height}`;

  let video: string;
  switch (params.video.mode) {
    case 'ivtc':
      video = thumbEnabled
        ? `[0:v]split[venc][vtmb];[venc]${IVTC_CHAIN}[1080p];[vtmb]deinterlace_qsv,fps=1/${interval},hwdownload,format=nv12,${thumbScale}[thumb]`
        : `[0:v]${IVTC_CHAIN}[1080p]`;
      break;
    case 'deinterlace':
      video = thumbEnabled
        ? `[0:v]vpp_qsv=deinterlace=advanced:rate=frame,split[1080p][tmpv];[tmpv]fps=1/${interval},${thumbScale}[thumb]`
        : `[0:v]vpp_qsv=deinterlace=advanced:rate=frame[1080p]`;
      break;
    case 'none':
      // No deinterlace stage. With `-hwaccel qsv -hwaccel_output_format qsv`
      // decoded frames are hardware surfaces, so the thumbnail branch must
      // hwdownload before the software scale — mirroring the ivtc thumb
      // branch (the deinterlace branch scales via vpp_qsv-produced frames
      // that ffmpeg transfers implicitly, kept verbatim from prod).
      video = thumbEnabled
        ? `[0:v]split[1080p][tmpv];[tmpv]fps=1/${interval},hwdownload,format=nv12,${thumbScale}[thumb]`
        : `[0:v]null[1080p]`;
      break;
  }

  return `${video};${audioFilters(params)}`;
}

/**
 * var_stream_map generated from the audio/subtitle arrays. For prod params it
 * must equal the legacy string:
 * `v:0,name:1080p,agroup:audio a:0,name:arib_1,agroup:audio,default:yes,language:ja a:1,name:arib_2,agroup:audio,language:en s:0,sgroup:arib,name:arib_ass,language:ja`
 */
function buildVarStreamMap(params: AribHlsParams, subtitlesEnabled: boolean): string {
  const parts = ['v:0,name:1080p,agroup:audio'];
  params.audio.forEach((a, i) => {
    const attrs = [`a:${i}`, `name:${a.name ?? `arib_${i + 1}`}`, 'agroup:audio'];
    if (a.isDefault ?? i === 0) attrs.push('default:yes');
    const language = a.language ?? defaultAudioLanguage(i);
    if (language !== undefined) attrs.push(`language:${language}`);
    parts.push(attrs.join(','));
  });
  if (subtitlesEnabled) {
    const name = params.subtitles?.name ?? 'arib_ass';
    const language = params.subtitles?.language ?? 'ja';
    parts.push(`s:0,sgroup:arib,name:${name},language:${language}`);
  }
  return parts.join(' ');
}

function build(params: AribHlsParams, ctx: TemplateCtx): string[] {
  const out = ctx.outDir;
  const thumbEnabled = params.thumbnail?.enabled ?? true;
  const subtitlesEnabled = params.subtitles?.enabled ?? true;
  const gop = params.video.gop ?? (params.video.mode === 'ivtc' ? '24000/1001' : '30000/1001');

  const argv = [
    '-nostats',
    '-hide_banner',
    '-hwaccel',
    'qsv',
    '-hwaccel_output_format',
    'qsv',
    '-analyzeduration',
    '3000000',
    '-probesize',
    '1G',
    '-start_at_zero',
    '-avoid_negative_ts',
    'disabled',
    '-f',
    'mpegts',
    '-font:s',
    'WadaLabChuMaruGo2004ARIB',
    '-rw_timeout',
    '5000000',
    // prod repeats `-analyzeduration 3000000` here — deliberately dropped (deviation 1)
    '-i',
    '-',
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
    buildFilterComplex(params, thumbEnabled),
    '-map',
    '[1080p]',
    '-c:v:0',
    params.video.codec ?? 'hevc_qsv',
    '-b:v:0',
    params.video.bitrate ?? '3M',
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
    gop,
    '-preset:v:0',
    String(params.video.preset ?? 7),
    '-aspect:v:0',
    '16:9',
  ];

  params.audio.forEach((a, i) => {
    argv.push('-map', `[audio${i}]`, `-c:a:${i}`, 'libfdk_aac', `-b:a:${i}`, a.bitrate ?? defaultAudioBitrate(i));
  });

  if (subtitlesEnabled) {
    argv.push('-map', '0:s:0', '-c:s', 'ass', '-hls_subtitle_type', 'ass');
  }

  argv.push(
    '-f',
    'hls',
    '-hls_time',
    String(params.hls?.segmentSeconds ?? 5),
    '-hls_list_size',
    String(params.hls?.listSize ?? 120),
    '-hls_segment_filename',
    `${out}/%v/%Y%m%d-%H%M%S.ts`,
    '-strftime',
    '1',
    '-hls_segment_type',
    'mpegts',
    '-hls_flags',
    'delete_segments+append_list+discont_start+omit_endlist+program_date_time',
  );

  if (subtitlesEnabled) {
    argv.push(
      '-hls_subtitle_path',
      `${out}/%v/playlist.m3u8`,
      '-hls_subtitle_segment_filename',
      `${out}/%v/%Y%m%d-%H%M%S.ass`,
    );
  }

  argv.push(
    '-var_stream_map',
    buildVarStreamMap(params, subtitlesEnabled),
    '-master_pl_name',
    'playlist.m3u8',
    `${out}/%v/stream.m3u8`,
  );

  if (thumbEnabled) {
    argv.push('-map', '[thumb]', '-update', '1', '-atomic_writing', '1', '-y', `${out}/thumb.jpg`);
  }

  if (ctx.progress) {
    argv.push('-progress', 'pipe:3'); // deviation 2 — session layer's progress channel
  }

  return argv;
}

export const aribHlsTemplate: PipelineTemplate<AribHlsParams> = {
  id: 'arib-hls',
  version: 1,
  requiredCaps: ['qsv', 'opencl'],
  schema: AribHlsParams,
  build,
};
