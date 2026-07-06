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
 * Pipeline template registry. The daemon owns each template's filter-graph
 * skeleton, stream mapping, var_stream_map and HLS muxer wiring; profiles
 * (via the contract's PipelineParams) only fill constrained knobs. The
 * registry also feeds `/v1/status.templates` and capability matching.
 */

import type { TSchema } from '@sinclair/typebox';
import type { PipelineParams } from '../../contract/v1.js';
import { aribHlsTemplate } from './aribHls.js';

export interface TemplateCtx {
  /** session output directory (`<serveDir>/<name>`), forward slashes */
  outDir: string;
  /** append `-progress pipe:3` (enabled by the session layer, not by profiles) */
  progress?: boolean;
}

export interface PipelineTemplate<P> {
  id: string;
  version: number;
  /** matched against the daemon's configured capabilities (e.g. ['qsv', 'opencl']) */
  requiredCaps: string[];
  /** the contract params schema this template consumes */
  schema: TSchema;
  /** pure: params + ctx → ffmpeg argv (binary path excluded) */
  build(params: P, ctx: TemplateCtx): string[];
}

export class UnknownTemplateError extends Error {
  constructor(
    readonly templateId: string,
    readonly templateVersion: number,
  ) {
    super(`unknown pipeline template ${templateId}@${templateVersion}`);
    this.name = 'UnknownTemplateError';
  }
}

/**
 * All templates this daemon can build, keyed by id.
 *
 * PipelineParams is currently a single-member union, so every registered
 * template consumes the full union; when a second template lands, narrow the
 * params type inside `getTemplate` on the `template` discriminant.
 */
export const templates: Readonly<Record<string, PipelineTemplate<PipelineParams> | undefined>> = {
  [aribHlsTemplate.id]: aribHlsTemplate,
};

/** id + version lookup; throws UnknownTemplateError so callers can 400 with details */
export function getTemplate(params: PipelineParams): PipelineTemplate<PipelineParams> {
  const template = templates[params.template];
  if (!template || template.version !== params.templateVersion) {
    throw new UnknownTemplateError(params.template, params.templateVersion);
  }
  return template;
}
