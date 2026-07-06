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
 * Switcher entry point — the second deployable in this repo. Autonomy
 * pattern: desired state + active selections restored from the state file at
 * boot, so serving and failover survive controller outages and the
 * switcher's own restarts.
 */

import { loadSwitcherConfig } from './config.js';
import { SwitcherStore } from './desiredStore.js';
import { buildServer } from './server.js';
import { Stitcher } from './stitch.js';
import { VERSION } from '../version.js';

async function main(): Promise<void> {
  const config = loadSwitcherConfig();
  const store = new SwitcherStore(config.stateFile, console);
  const persisted = await store.load();

  // fire-and-forget persistence for autonomous (failover) selection changes;
  // API mutations additionally await an explicit save in server.ts
  function persist(): void {
    store
      .save(stitcher.getDesired(), stitcher.getSelections())
      .catch((err: unknown) =>
        console.error(`failed to persist switcher state: ${err instanceof Error ? err.message : String(err)}`),
      );
  }

  const stitcher = new Stitcher({
    cacheTtlMs: config.cacheTtlMs,
    stallGraceSec: config.stallGraceSec,
    logger: console,
    onSelectionsChanged: persist,
  });

  if (persisted.desired) {
    stitcher.applyDesired(persisted.desired, persisted.selections);
    console.log(
      `restored desired state (revision ${persisted.desired.revision}, ` +
        `${persisted.desired.channels.length} channel(s)) from ${config.stateFile}`,
    );
  } else {
    console.log(`no persisted desired state at ${config.stateFile} — waiting for a controller push`);
  }

  const probeTimer = setInterval(() => {
    stitcher.probeAll().catch((err: unknown) => {
      console.error(`background probe failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, config.probeIntervalMs);
  probeTimer.unref();

  const app = buildServer({ stitcher, store, version: VERSION, logger: console });
  await app.listen({ host: config.listen.host, port: config.listen.port });
  console.log(`switcher ${VERSION} listening on ${config.listen.host}:${config.listen.port}`);

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}, shutting down`);
    clearInterval(probeTimer);
    app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error(`error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      });
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
