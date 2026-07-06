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
 * Daemon entry point: config → supervisor (reconciling from the persisted
 * desired doc with zero controller involvement) → HTTP API.
 *
 * The Session class carries the real seams as defaults (undici streaming
 * fetch, node:child_process spawn, node:fs/promises, wall-clock timers,
 * /proc statm RSS sampling), so the supervisor's default session factory is
 * fully production-wired here — only the pipeline builder is bound to config.
 */

import { createServer } from './api/server.js';
import { loadConfig } from './config.js';
import type { DesiredSession } from './contract/v1.js';
import { buildPipeline } from './pipeline/build.js';
import { SourcesCatalog } from './sources/catalog.js';
import { DesiredStore } from './state/desiredStore.js';
import { Supervisor } from './supervise/supervisor.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
  const logger = console;
  const config = loadConfig();

  // Degrade, don't crash: a bug in one session's plumbing must not take down
  // the supervisor for every other running stream. systemd would restart us,
  // but a restart bounces every ffmpeg on the host.
  process.on('unhandledRejection', (reason) => {
    logger.error(`unhandled rejection (continuing): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  });
  process.on('uncaughtException', (err) => {
    logger.error(`uncaught exception (continuing): ${err.stack ?? err.message}`);
  });

  const store = new DesiredStore(config.stateFile, logger);
  const supervisor = new Supervisor({
    buildPipeline: (session: DesiredSession) =>
      buildPipeline(session, {
        serveDir: config.serveDir,
        tvhBaseUrl: config.tvhBaseUrl,
        defaultWeight: config.defaultWeight,
        progress: true,
      }),
    store,
    config,
    logger,
    daemonVersion: VERSION,
  });

  await supervisor.startFromDisk();

  // external-sources catalog: first read before the API is reachable, then
  // the 5s mtime poll (no-op when sourcesM3u is null)
  const catalog = new SourcesCatalog(config.sourcesM3u, { logger });
  await catalog.start();

  const server = createServer({ supervisor, config, catalog, logger });
  await server.listen({ host: config.listen.host, port: config.listen.port });
  logger.info(
    `restreamer ${VERSION} listening on ${config.listen.host}:${config.listen.port} ` +
      `(serveDir ${config.serveDir}, stateFile ${config.stateFile}, tvh ${config.tvhBaseUrl})`,
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal} — stopping API, then draining sessions`);
    void (async () => {
      catalog.stop();
      await server.close().catch((err: unknown) => {
        logger.warn(`server close failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      // graceful per-session teardown: abort source → flush → SIGTERM → SIGKILL
      await supervisor.stopAll();
      logger.info('shutdown complete');
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(`fatal during startup: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
