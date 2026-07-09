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

import { defineConfig } from 'vitest/config';

// Config for the end-to-end suite (test/e2e.test.ts): real Supervisor + real
// Fastify server + real child processes on fixture scripts. Excluded from the
// default `pnpm test` (see vitest.config.ts) because it costs more wall-clock
// than the rest of the suite combined.
export default defineConfig({
  test: {
    include: ['test/e2e.test.ts'],
  },
});
