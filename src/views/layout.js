import { html } from 'hono/html';

const SITE_NAME = 'I ♥ RSS';

/**
 * Shared shell for every HTML page.
 *
 * `title` is the page title (the site name is appended), `body` is an
 * already-rendered `hono/html` fragment, `config` carries `siteUrl` so the
 * discovery links in `<head>` are absolute.
 *
 * Favicons: the SVG is listed first so modern browsers prefer the vector and get
 * a crisp icon at any DPI; `favicon.ico` and the two PNG sizes are the fallback
 * for Safari and older browsers, which ignore `image/svg+xml`.
 *
 * `apple-touch-icon.png` is deliberately the one asset with **no alpha channel**
 * (§6.1). iOS composites a transparent home-screen icon onto black, so the
 * generated file — transparent in all four corners — would have put an orange
 * heart on a black tile. It is flattened onto opaque white instead.
 *
 * The OPML discovery links land here in phase 6, now that /subscriptions.opml
 * exists — advertising them earlier would have pointed the exact crawlers that
 * auto-discover them (HyperTexting, Micro.blog) at a 404 for four phases.
 *
 * **Two elements, not one `rel="following blogroll"`** (§6.4). They serve two
 * consumers that spell it differently: HyperTexting documents `rel="following"` as
 * the recommended form and matches `rel` as a token list, while the Winer-adjacent
 * ecosystem spells it `blogroll` with `type="text/xml"` (scripting.com serves exactly
 * that). HyperTexting would handle a combined value, but there is no guarantee the
 * older blogroll readers do, and a string-comparing parser would miss it. Two lines
 * is cheap insurance. `subscriptions` is skipped: `following` already covers the one
 * consumer that recognises it.
 *
 * `scripts` is a list of same-origin script paths, and it is a **parameter rather
 * than a line in this template** because this function renders every page. §10's
 * feed reader is wanted on `/` and nowhere else; hardcoding its tag here would
 * make /about, /guide and the rest download and execute a component that has no
 * element to attach to. Each entry becomes a `defer`red external tag — deferred
 * because the element it hydrates is below the fold and blocking the parser on the
 * one page that most needs to be fast is the wrong trade, external because the CSP
 * allows `script-src 'self'` and deliberately not `'unsafe-inline'`.
 */
export function layout({ title, body, config, description, scripts = [] }) {
  const fullTitle = title ? `${title} — ${SITE_NAME}` : SITE_NAME;
  const feedUrl = new URL('/feed.xml', config.siteUrl).href;
  const opmlUrl = new URL('/subscriptions.opml', config.siteUrl).href;

  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fullTitle}</title>
${description ? html`<meta name="description" content="${description}">` : ''}
<link rel="alternate" type="application/rss+xml" title="${SITE_NAME}" href="${feedUrl}">
<link rel="following" type="text/x-opml" title="${SITE_NAME} members" href="${opmlUrl}">
<link rel="blogroll" type="text/xml" title="${SITE_NAME} members" href="${opmlUrl}">
<link rel="icon" href="/iheartrss-icon.svg" type="image/svg+xml">
    <link rel="icon" href="/favicon.ico" sizes="32x32">
    <link rel="icon" href="/favicon-32x32.png" type="image/png" sizes="32x32">
    <link rel="icon" href="/favicon-16x16.png" type="image/png" sizes="16x16">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
    <link rel="manifest" href="/site.webmanifest">
<link rel="stylesheet" href="/style.css">
${scripts.map((src) => html`<script src="${src}" defer></script>`)}
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
      <li><a href="/blog">Blog</a></li>
      <li><a href="/sites">Members</a></li>
      <li><a href="/submit">Submit</a></li>
      <li><a href="/guide">Guide</a></li>
      <li><a href="/badge">Badge</a></li>
      <li><a href="/about">About</a></li>
    </ul>
  </nav>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
  <p>
    <a href="/about">About</a> &middot;
    <a href="/blog">Blog</a> &middot;
    <a href="/badge">Badge</a> &middot;
    <a href="/guide">Guide</a> &middot;
    <a href="/sites">Members</a> &middot;
    <a href="/status">Status</a> &middot;
    <a href="/subscriptions.opml">OPML</a> &middot;
    <a href="/feed.xml">RSS</a>
  </p>
  <p class="site-footer__note">A directory for people who love RSS.</p>
</footer>
</body>
</html>`;
}
