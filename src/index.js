/**
 * Process entrypoint: start the catalogue refresh loop and the HTTP server,
 * then drain gracefully on SIGTERM/SIGINT.
 */

import { config } from './config.js';
import * as log from './log.js';
import { startCatalogRefresh } from './catalog/index.js';
import { startEpgRefresh } from './epg/index.js';
import { createServer } from './server/index.js';

const DRAIN_MS = 5000;

let server;
try {
  server = createServer();
} catch (err) {
  log.error('fatal: could not create server', err);
  process.exit(1);
}

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal, drainMs: DRAIN_MS });

  const force = setTimeout(() => {
    log.warn('shutdown drain expired, closing remaining connections');
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    process.exit(1);
  }, DRAIN_MS);
  if (typeof force.unref === 'function') force.unref();

  server.close((err) => {
    clearTimeout(force);
    if (err) {
      log.error('shutdown failed', err);
      process.exit(1);
    }
    log.info('shutdown complete');
    process.exit(0);
  });

  // Stop keeping idle keep-alive sockets around during the drain.
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.on('error', (err) => {
  log.error('fatal: server error', err);
  process.exit(1);
});

startCatalogRefresh()
  .then((stats) => {
    log.info('catalogue: initial refresh finished', {
      channels: stats.channels,
      events: stats.events,
      errors: stats.errors.length,
    });
    // Fire-and-forget: the guide is an enrichment, the bridge serves without it.
    return startEpgRefresh().then((guide) => {
      log.info('epg: initial refresh finished', {
        matched: guide.matched,
        programmes: guide.programmes,
        errors: guide.errors.length,
      });
    });
  })
  .catch((err) => {
    log.warn('catalogue: initial refresh failed', err);
  });

server.listen(config.port, config.host, () => {
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : config.port;
  log.info(`listening on http://${config.host}:${port}`, {
    host: config.host,
    port,
    catalogRefreshMin: config.catalogRefreshMin,
  });
});
