import { html } from 'hono/html';

import { layout } from './layout.js';

export function badgePage({ config }) {
  const home = new URL('/', config.siteUrl).href;
  const light = new URL('/iheartrss.svg', config.siteUrl).href;
  const dark = new URL('/iheartrss-dark.svg', config.siteUrl).href;

  // Built as plain strings and interpolated, so hono/html escapes them for
  // display inside <pre><code>.
  const snippetLight = `<a href="${home}">
  <img src="${light}" alt="I love RSS" width="88" height="31">
</a>`;

  const snippetDark = `<a href="${home}">
  <img src="${dark}" alt="I love RSS" width="88" height="31">
</a>`;

  const snippetAuto = `<a href="${home}">
  <picture>
    <source srcset="${dark}" media="(prefers-color-scheme: dark)">
    <img src="${light}" alt="I love RSS" width="88" height="31">
  </picture>
</a>`;

  const snippetText = `<a href="${home}">I &hearts; RSS</a>`;

  const body = html`
<h1>The badge</h1>
<p class="lede">
  Put one of these on your homepage, pointing at
  <code>${home}</code>. That link is what we check when you submit your site.
</p>

<p class="note">
  <strong>The image is not mandatory.</strong> We look for an
  <code>&lt;a href&gt;</code> pointing at us &mdash; so a plain text link counts
  exactly the same as the button. Pick whichever suits your design.
</p>

<section>
  <h2>Button, on a light background</h2>
  <p class="badge-preview badge-preview--light">
    <a href="${home}"><img src="${light}" alt="I love RSS" width="88" height="31"></a>
  </p>
  <pre class="code"><code>${snippetLight}</code></pre>
</section>

<section>
  <h2>Button, on a dark background</h2>
  <p class="badge-preview badge-preview--dark">
    <a href="${home}"><img src="${dark}" alt="I love RSS" width="88" height="31"></a>
  </p>
  <pre class="code"><code>${snippetDark}</code></pre>
</section>

<section>
  <h2>Auto-switching</h2>
  <p>
    For sites that follow the visitor&rsquo;s OS theme. If your site is always light
    or always dark, use the fixed variant above instead &mdash; this one follows the
    <em>visitor</em>, not your page.
  </p>
  <pre class="code"><code>${snippetAuto}</code></pre>
</section>

<section>
  <h2>Text only</h2>
  <p class="badge-preview badge-preview--light">
    <a href="${home}">I &hearts; RSS</a>
  </p>
  <pre class="code"><code>${snippetText}</code></pre>
</section>

<section>
  <h2>Sizes</h2>
  <p>
    The artwork is 1760&times;620, which is exactly 20&times; an 88&times;31 button, so
    88&times;31 distorts nothing. Any multiple works the same way: 176&times;62,
    264&times;93, 352&times;124. It&rsquo;s SVG, so it is already sharp on retina
    screens &mdash; there are no <code>@2x</code> files to fetch. The
    <code>width</code> and <code>height</code> attributes are there to reserve space
    and stop the page jumping while the image loads.
  </p>
</section>

<section>
  <h2>The files</h2>
  <ul>
    <li><a href="/iheartrss.svg">iheartrss.svg</a> &mdash; wordmark for light backgrounds</li>
    <li><a href="/iheartrss-dark.svg">iheartrss-dark.svg</a> &mdash; wordmark for dark backgrounds</li>
    <li><a href="/iheartrss-icon.svg">iheartrss-icon.svg</a> &mdash; the heart on its own, square</li>
  </ul>
  <p>
    Hotlinking is fine &mdash; it&rsquo;s the point. Copy them onto your own server
    if you&rsquo;d rather.
  </p>
</section>

<section>
  <h2>Badge on, feed next</h2>
  <p>
    The other half of getting listed is an RSS 2.0 feed advertised in the
    <code>&lt;head&gt;</code> of the page carrying this badge.
    <a href="/guide">The guide</a> has the exact lines for Jekyll, Eleventy, Zola, Astro
    and hand-rolled sites, then <a href="/submit">submit your URL</a>.
  </p>
</section>
`;

  return layout({
    title: 'Badge',
    description:
      'Copy-paste I love RSS badge snippets — light, dark, auto-switching and text-only.',
    body,
    config,
  });
}
