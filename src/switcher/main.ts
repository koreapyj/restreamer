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
 * Switcher entry point — the second deployable in this repo. It dials the
 * controller over a persistent WebSocket (controllerLink.ts) and serves from
 * the last doc it received, so serving survives controller outages and its
 * own restarts once at least one doc has been applied — see readyz in
 * server.ts and the Deployment's rolling strategy in deploy/k8s/switcher.yaml.
 */

import { ControllerLink } from './controllerLink.js';
import { loadSwitcherConfig } from './config.js';
import { buildServer } from './server.js';
import { Stitcher } from './stitch.js';
import { VERSION } from '../version.js';

async function main(): Promise<void> {
  const config = loadSwitcherConfig();

  const stitcher = new Stitcher({
    cacheTtlMs: config.cacheTtlMs,
    stallGraceSec: config.stallGraceSec,
    logger: console,
  });

  const link = new ControllerLink({
    url: config.controllerUrl,
    stitcher,
    version: VERSION,
    logger: console,
  });

  const app = buildServer({ stitcher, link, version: VERSION, logger: console });

  const probeTimer = setInterval(() => {
    stitcher.probeAll().catch((err: unknown) => {
      console.error(`background probe failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, config.probeIntervalMs);
  probeTimer.unref();

  link.start();

  await app.listen({ host: config.listen.host, port: config.listen.port });
  console.log(`switcher ${VERSION} listening on ${config.listen.host}:${config.listen.port}`);

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}, shutting down`);
    clearInterval(probeTimer);
    Promise.all([link.stop(), app.close()])
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
