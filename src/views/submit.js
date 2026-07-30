import { html } from 'hono/html';

import { layout } from './layout.js';
import { rejectionMessage } from './messages.js';

/**
 * The submit form (plan §6, §6.3).
 *
 * Rendered on `/submit`, embedded on `/`, and re-rendered by `POST /submit` with a
 * result panel above it. One fragment for all three so the field attributes §6.3
 * requires can't drift between copies.
 */
export function submitForm({ action = '/submit', value = '', autofocus = false } = {}) {
  return html`
<form class="submit-form" method="post" action="${action}">
  <label for="url">Your site&rsquo;s URL</label>
  <input
    id="url"
    name="url"
    type="url"
    value="${value}"
    placeholder="https://example.com"
    inputmode="url"
    autocomplete="url"
    autocapitalize="off"
    autocorrect="off"
    spellcheck="false"
    ${autofocus ? 'autofocus' : ''}
    required>
  <p class="submit-form__hint">
    The page with the badge on it. We fetch it, find your RSS 2.0 feed and check the
    link back &mdash; it takes a few seconds.
  </p>
  <div class="submit-form__actions">
    <button type="submit">Submit my site</button>
    <button type="submit" class="button-secondary" formaction="/check">
      Just test it, don&rsquo;t list me
    </button>
  </div>
</form>`;
}

/**
 * The three "how to join" steps live here rather than on the homepage.
 *
 * They used to be on `/`, which meant explaining what to do in one place and asking
 * for the URL in another — and they pushed §10's feed reader well below the fold.
 * The steps end in the form, so the form is where they belong.
 *
 * A result panel, when there is one, stays above everything: someone who just got a
 * rejection is here to read it, not to re-read the instructions.
 */
export function submitPage({ config, result = null, submitted = '' }) {
  const badgeImg = '/iheartrss.svg';

  const body = html`
<section class="submit">
  <h1>Submit your site</h1>
  ${result === null ? '' : resultPanel({ config, result })}
  <p class="lede">
    Two things have to be true: your page links back to
    <a href="${config.siteUrl}">iheartrss.com</a>, and it advertises an
    <a href="/guide">RSS 2.0 feed</a> in its <code>&lt;head&gt;</code>.
  </p>

  <ol class="steps">
    <li>
      <h2>Put the badge on your homepage</h2>
      <p>
        Link to <code>${config.siteUrl}</code>. An image badge or a plain text link
        both count &mdash; we look at the link, not the picture.
      </p>
      <p>
        <a href="/"><img src="${badgeImg}" alt="I love RSS" width="88" height="31"></a>
      </p>
      <p><a href="/badge">Get the badge and copy-paste snippets &rarr;</a></p>
    </li>
    <li>
      <h2>Make sure your feed is discoverable</h2>
      <p>
        We look for an RSS 2.0 feed advertised in your page&rsquo;s
        <code>&lt;head&gt;</code>.
      </p>
      <p><a href="/guide">How to publish an RSS 2.0 feed &rarr;</a></p>
    </li>
    <li>
      <h2>Submit your URL</h2>
      ${submitForm({ value: submitted, autofocus: result !== null })}
    </li>
  </ol>

  <p>
    Not sure what&rsquo;s wrong? <a href="/guide">The guide</a> covers the three
    rejections we see most, per platform.
  </p>
</section>`;

  return layout({
    title: 'Submit your site',
    description: 'Add your site to the I ♥ RSS directory.',
    body,
    config,
  });
}

/**
 * §6: "re-renders with a detailed result panel". The panel names the exact
 * `xmlUrl` and `htmlUrl` we would publish, because those two values are what a
 * member needs to check — and getting the wrong feed is a real outcome of
 * autodiscovery picking the first `<link>` on a page with several.
 */
export function resultPanel({ config, result }) {
  if (result.outcome === 'added' || result.outcome === 'updated') {
    return html`
<div class="panel panel--ok">
  <h2>${result.outcome === 'added' ? "You're listed" : 'Updated'}</h2>
  <p>
    ${
      result.outcome === 'added'
        ? html`Welcome. You&rsquo;ll show up in
          <a href="/subscriptions.opml">the subscription list</a> and on
          <a href="/sites">the members page</a>.`
        : html`We re-checked your site and refreshed what we had.`
    }
  </p>
  ${publishedUrls(result)}
</div>`;
  }

  if (result.outcome === 'checked') {
    return html`
<div class="panel panel--ok">
  <h2>That would work</h2>
  <p>
    Nothing was listed &mdash; this was a test. Submit when you&rsquo;re ready.
  </p>
  ${publishedUrls(result)}
</div>`;
  }

  if (result.outcome === 'already_submitted') {
    // The deliberately NEUTRAL answer (§5 Step 7). A `hidden` row lands here, and
    // "you have been moderated" would be exactly the oracle that undoes the lever.
    return html`
<div class="panel panel--ok">
  <h2>Already submitted</h2>
  <p>
    We have this site on file and we&rsquo;ve refreshed what we know about it. You can
    check its state any time on <a href="/status?url=${encodeURIComponent(result.url ?? '')}">the
    status page</a>.
  </p>
</div>`;
  }

  const message = rejectionMessage({ result, config });

  return html`
<div class="panel panel--error">
  <h2>${message.heading}</h2>
  ${message.body}
  ${
    result.rateLimited
      ? ''
      : html`<p class="panel__foot">
        Fixed it? Submit again &mdash; re-submitting is safe and just re-checks you.
      </p>`
  }
</div>`;
}

function publishedUrls(result) {
  return html`
<dl class="published-urls">
  <dt>Your page (<code>htmlUrl</code>)</dt>
  <dd><a href="${result.url}">${result.url}</a></dd>
  <dt>Your feed (<code>xmlUrl</code>)</dt>
  <dd><a href="${result.feedUrl}">${result.feedUrl}</a></dd>
</dl>
<p class="published-urls__note">
  <strong>Wrong feed?</strong> That&rsquo;s the first
  <code>&lt;link rel="alternate" type="application/rss+xml"&gt;</code> on your page. If
  it isn&rsquo;t the one you meant, move the one you want first in your
  <code>&lt;head&gt;</code> and submit again &mdash; see
  <a href="/guide#autodiscovery">the guide</a>.
</p>`;
}
