import { html } from 'hono/html';

import { layout } from './layout.js';
import { rejectionMessage } from './messages.js';
import { submitForm } from './submit.js';

const STATUS_WORDS = {
  active: 'Listed and healthy.',
  failing:
    "Listed, but our last few checks didn't succeed. We keep trying for about " +
    'three weeks before dropping a site.',
  blocked:
    'Listed, but your host is blocking our checks (usually bot protection). We ' +
    'keep you in the list.',
  dropped: 'Not listed — our checks kept failing and we stopped.',
  removed: 'Not listed — the link back to us was gone on two separate checks.',
};

/**
 * `/status` (plan §6).
 *
 * A `hidden` row never reaches this view: the route passes `site: null`, so a
 * moderated member sees the same "not listed" page as a stranger. That neutrality is
 * the point — anything else is the oracle `/submit` and `/recheck` avoid.
 */
export function statusPage({
  config,
  query = '',
  url = '',
  site = undefined,
  invalid = false,
  notice = null,
}) {
  const body = html`
<section class="status">
  <h1>Check a site&rsquo;s status</h1>

  ${notice === null ? '' : noticePanel(notice)}
  <form class="submit-form" method="get" action="/status">
    <label for="url">Site URL</label>
    <input id="url" name="url" type="url" value="${query}" inputmode="url"
      autocomplete="url" autocapitalize="off" spellcheck="false" required>
    <button type="submit">Look it up</button>
  </form>

  ${
    invalid
      ? html`<div class="panel panel--error">
        <h2>That doesn&rsquo;t look like a URL</h2>
        <p>Try the full address, like <code>https://example.com</code>.</p>
      </div>`
      : ''
  }

  ${site === undefined ? '' : site === null ? notListed({ url }) : listed({ site })}
</section>`;

  return layout({ title: 'Status', body, config });
}

/**
 * The outcome of a `POST /recheck/:id`, above the row's current state.
 *
 * §6 requires a transient failure and a `blocked` outcome to be "logged and shown to
 * the caller, never written" — so this panel is the *only* trace either of them
 * leaves, and it has to say plainly that nothing changed.
 */
function noticePanel({ kind = 'ok', heading, body }) {
  return html`
<div class="panel ${kind === 'ok' ? 'panel--ok' : 'panel--error'}">
  <h2>${heading}</h2>
  ${body}
</div>`;
}

function notListed({ url }) {
  return html`
<div class="panel">
  <h2>Not listed</h2>
  <p>
    We have nothing listed for
    ${url ? html`<code>${url}</code>` : 'that address'}.
  </p>
  <p>
    We match on both the page you submitted and the page your feed names as its own, so
    if you were listed under a different URL, try that one too.
  </p>
  ${submitForm({ value: url })}
</div>`;
}

function listed({ site }) {
  return html`
<div class="panel">
  <h2>${site.title}</h2>
  <p class="status__state">${STATUS_WORDS[site.status] ?? site.status}</p>
  <dl class="published-urls">
    <dt>Page we publish (<code>htmlUrl</code>)</dt>
    <dd><a href="${site.url}">${site.url}</a></dd>
    <dt>Feed we publish (<code>xmlUrl</code>)</dt>
    <dd><a href="${site.feed_url}">${site.feed_url}</a></dd>
    <dt>You submitted</dt>
    <dd><code>${site.submitted_url}</code></dd>
    <dt>Last successful check</dt>
    <dd>${site.last_verified_at}</dd>
    <dt>Last check of any kind</dt>
    <dd>${site.last_checked_at}</dd>
    <dt>Consecutive failures</dt>
    <dd>${site.failure_count}</dd>
    ${
      site.last_error
        ? html`<dt>Last error</dt><dd><code>${site.last_error}</code></dd>`
        : ''
    }
  </dl>
  <p>
    Something look wrong? Re-check it now &mdash; a failed check from here never counts
    against you.
  </p>
  <form class="submit-form submit-form--inline" method="post" action="/recheck/${site.id}">
    <button type="submit">Re-check now</button>
  </form>
  <p>Or re-submit, which does the same thing and takes the URL you type:</p>
  ${submitForm({ value: site.submitted_url })}
</div>`;
}

/** `POST /report` (§6): "the OPML is consumed by other people's readers." */
export function reportPage({
  config,
  url = '',
  filed = false,
  error = null,
  retryAfterSeconds = 0,
}) {
  const body = html`
<section class="report">
  <h1>Report a listed site</h1>

  ${
    filed
      ? html`<div class="panel panel--ok">
        <h2>Thank you</h2>
        <p>Filed. A person reads these.</p>
      </div>`
      : ''
  }

  ${
    error === 'incomplete'
      ? html`<div class="panel panel--error">
        <h2>We need both fields</h2>
        <p>The URL of the listing, and what&rsquo;s wrong with it.</p>
      </div>`
      : error
        ? panelFor({ config, error, retryAfterSeconds })
        : ''
  }

  <p>
    We publish this list as an OPML file that other people subscribe to, so
    &ldquo;this member is now serving malware&rdquo; needs a route to us.
  </p>

  <form class="submit-form" method="post" action="/report">
    <label for="url">URL of the listing</label>
    <input id="url" name="url" type="url" value="${url}" inputmode="url"
      autocapitalize="off" spellcheck="false" required>

    <label for="reason">What&rsquo;s wrong?</label>
    <textarea id="reason" name="reason" rows="5" required></textarea>

    <label for="contact">Your contact (optional)</label>
    <input id="contact" name="contact" type="text" autocapitalize="off">

    <button type="submit">Send report</button>
  </form>
</section>`;

  return layout({ title: 'Report a site', body, config });
}

function panelFor({ config, error, retryAfterSeconds }) {
  const message = rejectionMessage({
    result: { reason: error, retryAfterSeconds },
    config,
  });

  return html`
<div class="panel panel--error">
  <h2>${message.heading}</h2>
  ${message.body}
</div>`;
}
