/**
 * Entry point: load config, build the app, listen.
 *
 * The app itself is built by `createApp({ config })` and never at module scope
 * (plan §11) — that is what keeps it testable as phases 3+ add a database and a
 * fetcher to inject.
 */

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp({ config });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    JSON.stringify({
      msg: 'listening',
      port: info.port,
      siteUrl: config.siteUrl,
    }),
  );
});

// Docker sends SIGTERM on `stop` and on redeploy; without this the container
// waits out the full 10s kill timeout on every deploy.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
