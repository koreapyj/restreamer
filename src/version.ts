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

import { createRequire } from 'node:module';

// Both src/version.ts (tsx) and dist/version.js (node) sit one level below
// the repo root, so ../package.json resolves from either location.
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

/** daemon/switcher version reported in /v1/status and the stream User-Agent */
export const VERSION: string = pkg.version;
