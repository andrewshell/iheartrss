import { Hono } from 'hono';

import { renderFeed } from './blog/feed.js';
import { registerStatic } from './routes/static.js';
import { aboutPage } from './views/about.js';
import { badgePage } from './views/badge.js';
import { notFoundPage } from './views/error.js';
import { homePage } from './views/home.js';

export function createApp({ config, checkHealth = () => ({ ok: true }) }) {
  const app = new Hono();

  // Plan §9: the container healthcheck only inspects the HTTP status, so an
  // unhealthy answer has to *be* a 503. `{ok: false}` with a 200 is a container
  // that never restarts. Phases 3+ fold the database into `checkHealth`.
  app.get('/healthz', (c) => {
    let result;
    try {
      result = checkHealth();
    } catch (err) {
      result = { ok: false, reason: err.message };
    }

    return result?.ok
      ? c.json({ ok: true })
      : c.json({ ok: false, reason: result?.reason ?? 'unhealthy' }, 503);
  });

  app.get('/', (c) => c.html(homePage({ config })));
  app.get('/about', (c) => c.html(aboutPage({ config })));
  app.get('/badge', (c) => c.html(badgePage({ config })));

  app.get('/feed.xml', (c) =>
    c.body(renderFeed({ config }), 200, {
      'Content-Type': 'application/rss+xml; charset=utf-8',
    }),
  );

  app.get('/robots.txt', (c) =>
    c.text(robotsTxt(), 200, {
      'Content-Type': 'text/plain; charset=utf-8',
    }),
  );

  // Registered last so a real route always wins over a file of the same name.
  registerStatic(app);

  app.notFound((c) => c.html(notFoundPage({ config }), 404));

  return app;
}

// Plan §6: allow the public pages, disallow the routes that either cost us an
// outbound fetch (/check, /recheck), leak state (/status) or are private (/admin).
// The `Sitemap:` line lands with /sitemap.xml in phase 7; pointing crawlers at a
// 404 until then is worse than omitting it.
function robotsTxt() {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /check',
    'Disallow: /recheck',
    'Disallow: /status',
    '',
  ].join('\n');
}
