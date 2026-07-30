import { html, raw } from 'hono/html';

import { DESCRIPTION_MAX, normalizeMetaText, TITLE_MAX } from '../lib/xml.js';
import { layout } from './layout.js';

/**
 * `/sites` (plan §6, §6.3).
 *
 * "A verification and transparency page, not a discovery surface" — it shows what is
 * in the OPML, so anyone can check that what we publish about them is what they
 * expect.
 *
 * Three §6.3 rules are load-bearing in the markup below:
 *
 *  * **A reflowing list, never a `<table>`.** Tables are the single most common
 *    mobile failure, and each entry here carries a title, a host, up to four badges
 *    and a date. `<ul>`/`<li>` plus flexbox stacks on a phone and spreads on a
 *    desktop, with no horizontal scroll at any width.
 *  * **All members on one page, newest first, no pagination.** Ctrl-F works, and
 *    `#site-<id>` from the submit success panel always resolves.
 *  * **A legend.** Nobody arrives knowing what the source namespace or rssCloud are,
 *    and nobody guesses that `blocked` is deliberately still listed.
 *
 * Titles and descriptions are normalised and capped here as well as at ingest (§7):
 * rows written before the ingest cap existed still have to render, and a 1 MB title
 * wrecks the layout for everyone.
 */
export function sitesPage({ config, members = [] }) {
  const body = html`
<section class="sites">
  <h1>Members</h1>
  <p class="lede">
    Every site in our <a href="/subscriptions.opml">OPML subscription list</a>,
    newest first. ${
      members.length === 1 ? html`One member so far.` : html`${members.length} members.`
    }
  </p>
  <p>
    Not here, or here and you&rsquo;d rather not be? Look yourself up on
    <a href="/status">the status page</a> &mdash; it says exactly what we know and
    why. Removing the badge takes you off the list within a week.
  </p>

  ${legend()}

  ${
    members.length === 0
      ? html`<p class="sites__empty">No members yet. <a href="/submit">Be the first.</a></p>`
      : html`<ul class="site-list">${members.map(row)}</ul>`
  }
</section>
`;

  return layout({
    title: 'Members',
    description:
      'Every site in the I ♥ RSS directory, with the feed we publish for it and what we last saw.',
    body,
    config,
  });
}

function row(site) {
  const title = normalizeMetaText(site.title, TITLE_MAX) || site.host;
  const description = normalizeMetaText(site.description, DESCRIPTION_MAX);

  return html`
  <li class="site" id="site-${site.id}">
    <h2 class="site__title"><a href="${site.url}" rel="nofollow noopener">${title}</a></h2>
    <p class="site__host">${site.host}</p>
    ${description ? html`<p class="site__description">${description}</p>` : ''}
    <p class="site__badges">${badges(site)}</p>
    <p class="site__meta">
      <a href="${site.feed_url}">feed</a>
      &middot;
      <time datetime="${site.created_at}">joined ${day(site.created_at)}</time>
    </p>
  </li>`;
}

/**
 * §6: "Badges for source-ns, rsscloud, `failing` and `blocked`."
 *
 * `title` on each one, because the legend is at the top of a page that can be long
 * and a badge two screens down has to explain itself where it sits.
 */
function badges(site) {
  const out = [];

  if (site.has_source_ns) {
    out.push(
      badge('source-ns', 'source ns', 'Publishes the source.scripting.com namespace.'),
    );
  }
  if (site.has_rsscloud) {
    out.push(badge('rsscloud', 'rssCloud', 'Announces updates over rssCloud.'));
  }
  if (site.status === 'failing') {
    out.push(
      badge(
        'failing',
        'failing',
        "Our last few checks didn't succeed. Still listed — we keep trying for about three weeks.",
      ),
    );
  }
  if (site.status === 'blocked') {
    out.push(
      badge(
        'blocked',
        'blocked',
        'Their host blocks our checks (usually bot protection). Still listed — that is not the member’s fault.',
      ),
    );
  }

  return out.length === 0 ? html`<span class="badge badge--none">listed</span>` : out;
}

function badge(kind, label, explanation) {
  return html`<span class="badge badge--${raw(kind)}" title="${explanation}">${label}</span>`;
}

/**
 * §6.3: "a legend explaining what the source-ns and rssCloud badges mean — nobody
 * arrives knowing that." Extended to the two state badges, since "listed but
 * blocked" is the one that reads like a mistake.
 */
function legend() {
  return html`
<section class="legend" aria-labelledby="legend-heading">
  <h2 id="legend-heading">What the badges mean</h2>
  <dl class="legend__list">
    <dt><span class="badge badge--source-ns">source ns</span></dt>
    <dd>
      The feed carries the <code>source.scripting.com</code> namespace &mdash; extra
      metadata some readers use, and a sign of a feed made with care.
    </dd>
    <dt><span class="badge badge--rsscloud">rssCloud</span></dt>
    <dd>
      The feed advertises rssCloud, so readers can be notified of new posts instead of
      polling.
    </dd>
    <dt><span class="badge badge--failing">failing</span></dt>
    <dd>
      Our last checks didn&rsquo;t succeed. Still in the list &mdash; we keep trying
      for about three weeks before dropping a site.
    </dd>
    <dt><span class="badge badge--blocked">blocked</span></dt>
    <dd>
      Their server answers our checks with bot protection (usually a 403). Being
      refused from a datacentre IP isn&rsquo;t the member&rsquo;s fault and usually
      isn&rsquo;t theirs to fix, so they stay in the list.
    </dd>
  </dl>
</section>`;
}

/** A plain YYYY-MM-DD: no locale guessing, and it sorts the way it reads. */
function day(timestamp) {
  return String(timestamp).slice(0, 10);
}
