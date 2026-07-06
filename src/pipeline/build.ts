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
 * Pure DesiredSession → process-plan builder. No fs, no child_process — the
 * supervisor spawns from the result, and `PUT /v1/desired` runs this as its
 * all-or-nothing dry-run validation before persisting.
 */

import { Value } from '@sinclair/typebox/value';
import { DesiredSession } from '../contract/v1.js';
import { getTemplate } from './templates/index.js';
import { buildTsreadexArgv } from './tsreadex.js';

export interface BuildCtx {
  /** HLS output root; session writes to `<serveDir>/<name>/` */
  serveDir: string;
  /** local tvheadend base URL, no trailing slash */
  tvhBaseUrl: string;
  /** subscription weight when the session doesn't specify one */
  defaultWeight: number;
  /** enable ffmpeg `-progress pipe:3` (session layer sets this; dry runs don't) */
  progress?: boolean;
}

export interface BuiltPipeline {
  sourceUrl: string;
  tsreadexArgv: string[];
  ffmpegArgv: string[];
  /** forward-slash path — target runtime is Linux */
  outDir: string;
}

export class PipelineBuildError extends Error {
  constructor(
    message: string,
    readonly details: string[],
  ) {
    super(details.length > 0 ? `${message}: ${details.join('; ')}` : message);
    this.name = 'PipelineBuildError';
  }
}

export function buildPipeline(session: DesiredSession, ctx: BuildCtx): BuiltPipeline {
  const filled = Value.Default(DesiredSession, Value.Clone(session)) as DesiredSession;
  if (!Value.Check(DesiredSession, filled)) {
    const details = [...Value.Errors(DesiredSession, filled)].map(
      (e) => `${e.path || '/'}: ${e.message} (got ${JSON.stringify(e.value)})`,
    );
    const name = typeof (session as { name?: unknown }).name === 'string' ? (session as { name: string }).name : '?';
    throw new PipelineBuildError(`invalid session ${name}`, details);
  }

  const template = getTemplate(filled.pipeline);
  const outDir = `${ctx.serveDir}/${filled.name}`;
  const sourceUrl =
    'url' in filled.source
      ? filled.source.url
      : `${ctx.tvhBaseUrl}/stream/channel/${filled.source.channelUuid}?profile=${
          filled.source.streamProfile ?? 'pass'
        }&weight=${filled.source.weight ?? ctx.defaultWeight}`;

  return {
    sourceUrl,
    tsreadexArgv: buildTsreadexArgv(filled.tsreadex),
    ffmpegArgv: template.build(filled.pipeline, { outDir, progress: ctx.progress }),
    outDir,
  };
}
