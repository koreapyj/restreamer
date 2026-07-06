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

import type { TsreadexParams } from '../contract/v1.js';

/**
 * argv for tsreadex (binary path excluded — the supervisor owns that).
 *
 * Reproduces the production invocation from `restreamer.sh`:
 * `tsreadex -n <sid> -a 13 -b 7 -c 5 -u 2 -` — trailing `-` reads stdin.
 * The `??` fallbacks mirror the contract-schema defaults so this stays
 * correct even when the caller has not run `Value.Default` first.
 */
export function buildTsreadexArgv(params: TsreadexParams): string[] {
  return [
    '-n',
    String(params.programNumber),
    '-a',
    String(params.audio1Mode ?? 13),
    '-b',
    String(params.audio2Mode ?? 7),
    '-c',
    String(params.captionMode ?? 5),
    '-u',
    String(params.superimposeMode ?? 2),
    '-',
  ];
}
