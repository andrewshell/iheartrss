import { html } from 'hono/html';

const SITE_NAME = 'I ♥ RSS';

/**
 * Shared shell for every HTML page.
 *
 * `title` is the page title (the site name is appended), `body` is an
 * already-rendered `hono/html` fragment, `config` carries `siteUrl` so the
 * discovery links in `<head>` are absolute.
 *
 * Note: only the SVG favicon is linked. The plan's `favicon.ico` and
 * `apple-touch-icon.png` are hand-generated one-offs that do not exist yet;
 * linking them before they are committed would advertise two 404s.
 *
 * The OPML discovery links (`rel="following"` / `rel="blogroll"`) are
 * deliberately absent until /subscriptions.opml exists (plan §12, phase 6).
 */
export function layout({ title, body, config, description }) {
  const fullTitle = title ? `${title} — ${SITE_NAME}` : SITE_NAME;
  const feedUrl = new URL('/feed.xml', config.siteUrl).href;

  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fullTitle}</title>
${description ? html`<meta name="description" content="${description}">` : ''}
<link rel="alternate" type="application/rss+xml" title="${SITE_NAME}" href="${feedUrl}">
<link rel="icon" href="/iheartrss-icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
<header class="site-header">
  <a class="site-header__home" href="/">
    <picture>
      <source srcset="/iheartrss-dark.svg" media="(prefers-color-scheme: dark)">
      <img src="/iheartrss.svg" alt="${SITE_NAME}" width="128" height="45">
    </picture>
  </a>
  <nav class="site-nav" aria-label="Main">
    <ul>
      <li><a href="/">Home</a></li>
      <li><a href="/badge">Badge</a></li>
      <li><a href="/about">About</a></li>
      <li><a href="/feed.xml">Feed</a></li>
    </ul>
  </nav>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
  <p>
    <a href="/about">About</a> &middot;
    <a href="/badge">Badge</a> &middot;
    <a href="/feed.xml">RSS</a>
  </p>
  <p class="site-footer__note">A directory for people who love RSS.</p>
</footer>
</body>
</html>`;
}
