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
 * 'raw-argv' v1 — a fully pre-rendered ffmpeg argv supplied by the controller.
 * The daemon does not interpret the argv; it only substitutes `{OUT_DIR}`
 * tokens and appends the progress channel, mirroring the arib-hls template's
 * only argv addition vs its params (`-progress pipe:3` when ctx.progress is
 * set).
 */

import { RawArgvParams } from '../../contract/v1.js';
import type { PipelineTemplate, TemplateCtx } from './index.js';

/** exact-substring replacement of every `{OUT_DIR}` occurrence in each token */
function substituteOutDir(argv: readonly string[], outDir: string): string[] {
  return argv.map((tok) => tok.split('{OUT_DIR}').join(outDir));
}

function build(params: RawArgvParams, ctx: TemplateCtx): string[] {
  const argv = substituteOutDir(params.ffmpegArgv, ctx.outDir);

  if (ctx.progress) {
    argv.push('-progress', 'pipe:3');
  }

  return argv;
}

export const rawArgvTemplate: PipelineTemplate<RawArgvParams> = {
  id: 'raw-argv',
  version: 1,
  requiredCaps: [],
  schema: RawArgvParams,
  build,
};
