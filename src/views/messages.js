import { html } from 'hono/html';

/**
 * Reason code → the words a human reads (plan §5, §6).
 *
 * Three rules, all from the plan and all easy to lose in a refactor:
 *
 *  * **Actionable and non-accusatory.** Most rejections are honest
 *    misconfigurations by people who already did the work of adding our badge.
 *  * **Name both URLs** where the rejection is about a relationship between them.
 *    "A wrong `<channel><link>` is the single most confusing rejection we produce"
 *    (§6.2), and it is unreadable without both values on screen.
 *  * **`feed_not_rss2` is the site's pitch, not a validator complaint** (§1, "what
 *    RSS-2.0-only costs, and what we owe in return"). It links to `/guide`, which
 *    ships in this phase precisely so this message isn't a dead end.
 */
export function rejectionMessage({ result, config }) {
  const reason = result.reason ?? 'error';
  const build = MESSAGES[reason] ?? MESSAGES.error;

  return build({ result, config, url: result.url ?? result.submittedUrl ?? '' });
}

const guide = (fragment = '') => html`<a href="/guide${fragment}">the guide</a>`;

const MESSAGES = {
  invalid_url: () => ({
    heading: "That doesn't look like a URL",
    body: html`<p>
      Try the full address of your homepage, like <code>https://example.com</code>.
    </p>`,
  }),

  unsupported_scheme: () => ({
    heading: 'We can only fetch http and https',
    body: html`<p>
      Whatever is behind that scheme, we have no way to read it. If your site is on the
      web, its address starts with <code>https://</code>.
    </p>`,
  }),

  // Deliberately terse and final. This is the one message with nothing to fix.
  banned: () => ({
    heading: "We can't list that site",
    body: html`<p>
      If you think that's a mistake, the contact address on
      <a href="/about">the about page</a> reaches a person.
    </p>`,
  }),

  self_listing: () => ({
    heading: "That's us",
    body: html`<p>
      iheartrss.com is already the first entry in its own list. Submit the site you
      publish instead.
    </p>`,
  }),

  page_fetch_failed: ({ url, result }) => ({
    heading: "We couldn't fetch your page",
    body: html`<p>
      We asked for <code>${url}</code>${
        result.status ? html` and got HTTP ${result.status}` : ' and the request failed'
      }.
      Nothing here needs fixing on our side, so it's worth loading that exact URL in a
      private window to see what a stranger sees.
    </p>`,
  }),

  ssrf_blocked: ({ url }) => ({
    heading: "That address isn't on the public internet",
    body: html`<p>
      <code>${url}</code> resolves to a private, loopback or link-local address. We only
      fetch publicly routable hosts &mdash; if you're testing locally, deploy first.
    </p>`,
  }),

  timeout: () => ({
    heading: 'Your site took too long',
    body: html`<p>
      We give each submission about 30 seconds for everything it needs to fetch, and
      that ran out. This is usually temporary &mdash; try again in a few minutes.
    </p>`,
  }),

  too_many_redirects: ({ url }) => ({
    heading: 'Too many redirects',
    body: html`<p>
      <code>${url}</code> kept redirecting. Submitting the address it finally settles on
      usually fixes it.
    </p>`,
  }),

  page_too_large: () => ({
    heading: 'That page is very large',
    body: html`<p>
      We stop reading at 5 MB, and we treat that as an error rather than guessing from a
      truncated page. If your homepage is genuinely that big, submitting a smaller page
      that carries the badge and the feed link works just as well.
    </p>`,
  }),

  feed_too_large: () => ({
    heading: 'That feed is very large',
    body: html`<p>
      We stop reading at 5 MB. Most feeds this size are publishing their entire archive
      &mdash; limiting the feed to the most recent posts is kinder to every reader, not
      just to us.
    </p>`,
  }),

  blocked_by_site: ({ url }) => ({
    heading: 'Your host is blocking us',
    body: html`<p>
      <code>${url}</code> answered <strong>403 Forbidden</strong>. That is almost always
      bot protection &mdash; Cloudflare, a WAF, or a host-level rule &mdash; and not
      anything you did wrong.
    </p>
    <p>
      <a href="/about">The about page</a> lists our exact <code>User-Agent</code> and
      source IP so you can allow it. Once that's in place, submit again.
    </p>`,
  }),

  no_feed_link: ({ url }) => ({
    heading: "We couldn't find a feed on your page",
    body: html`<p>
      <code>${url}</code> loaded fine, but its <code>&lt;head&gt;</code> doesn't advertise
      an RSS feed. One line does it:
    </p>
    <pre class="code"><code>&lt;link rel="alternate" type="application/rss+xml"
      title="Your site" href="/feed.xml"&gt;</code></pre>
    <p>${guide('#autodiscovery')} has the copy-paste version for your platform.</p>`,
  }),

  // §1: RSS-2.0-only is our decision, so the cost of it is ours to carry. This
  // message is the site's pitch, not a validator complaint.
  feed_not_rss2: ({ result }) => ({
    heading: 'We found a feed, just not an RSS 2.0 one',
    body: html`<p>
      ${
        result.otherFormatUrl
          ? html`Your page points at <code>${result.otherFormatUrl}</code>, which is
            ${result.otherFormatType === 'json' ? 'a JSON feed' : 'an Atom feed'}.`
          : 'The feed your page points at is not RSS 2.0.'
      }
      That's a perfectly good feed &mdash; we're the narrow ones here.
    </p>
    <p>
      We list RSS 2.0 only, because the whole point of this directory is one OPML file
      that every reader can subscribe to, and RSS 2.0 is the format they all agree on.
      It also carries <code>&lt;cloud&gt;</code> and the
      <code>source:</code> extensions the rest of this ecosystem is built on.
    </p>
    <p>
      Almost every generator can emit both, and keeping your Atom feed costs you
      nothing. ${guide()} has the exact template for Jekyll, Eleventy, Zola, Astro and
      hand-rolled sites &mdash; most of them are a five-minute change.
    </p>`,
  }),

  feed_fetch_failed: ({ result }) => ({
    heading: "We couldn't fetch your feed",
    body: html`<p>
      Your page advertises <code>${result.feedUrl ?? 'a feed'}</code>, but that URL
      ${result.status ? html`answered HTTP ${result.status}` : "didn't respond"}. A
      stale <code>href</code> in the <code>&lt;head&gt;</code> after a site move is the
      usual cause.
    </p>`,
  }),

  feed_invalid: ({ result }) => ({
    heading: "Your feed wouldn't parse",
    body: html`<p>
      <code>${result.feedUrl ?? 'The feed'}</code> isn't well-formed XML, or it's missing
      a <code>&lt;channel&gt;&lt;title&gt;</code>. ${guide('#template')} has a minimal,
      complete RSS 2.0 document you can compare against.
    </p>`,
  }),

  no_channel_link: ({ result }) => ({
    // Plain text: `heading` is interpolated into an <h2> and correctly escaped, so
    // markup here would render as literal angle brackets.
    heading: 'Your feed needs a channel link',
    body: html`<p>
      <code>${result.feedUrl ?? 'Your feed'}</code> doesn't say which site it belongs to.
      Add the site's own address inside <code>&lt;channel&gt;</code>:
    </p>
    <pre class="code"><code>&lt;channel&gt;
  &lt;title&gt;Your site&lt;/title&gt;
  &lt;link&gt;https://example.com/&lt;/link&gt;</code></pre>
    <p>
      That value is what we list as your page, so it needs to be the site the feed is
      for. ${guide('#channel-link')} explains it.
    </p>`,
  }),

  canonical_fetch_failed: ({ result }) => ({
    heading: "Your feed points at a page we couldn't fetch",
    body: html`<p>
      Your feed's <code>&lt;channel&gt;&lt;link&gt;</code> is
      <code>${result.url}</code>${result.status ? html`, which answered HTTP ${result.status}` : ", which didn't respond"}.
      We list the page the feed claims as its own, so that page has to load.
    </p>
    <p>
      If that address is out of date, correcting
      <code>&lt;channel&gt;&lt;link&gt;</code> is the fix &mdash; see
      ${guide('#channel-link')}.
    </p>`,
  }),

  feed_not_declared_on_canonical: ({ result }) => ({
    heading: 'Those two pages disagree about your feed',
    body: html`<p>
      Your feed says it belongs to <code>${result.url}</code>, but that page doesn't
      advertise a feed at all. We publish the feed that the page we list declares
      itself &mdash; otherwise anyone could get us to publish someone else's feed.
    </p>
    <p>The fix is one line in the <code>&lt;head&gt;</code> of <code>${result.url}</code>:</p>
    <pre class="code"><code>&lt;link rel="alternate" type="application/rss+xml"
      title="Your site" href="/feed.xml"&gt;</code></pre>
    <p>${guide('#autodiscovery')} covers this, including where the tag has to go.</p>`,
  }),

  canonical_feed_unavailable: ({ result }) => ({
    heading: "We couldn't read the feed on that page",
    body: html`<p>
      <code>${result.url}</code> is the page your feed claims, and it advertises
      <code>${result.feedUrl}</code> &mdash; but we couldn't fetch or parse that one.
      This is usually temporary; try again shortly.
    </p>`,
  }),

  feed_not_owned_by_canonical: ({ result }) => ({
    heading: "That feed isn't declared by the page we'd list",
    body: html`<p>
      We would list <code>${result.url}</code>, and the feed
      <code>${result.feedUrl}</code> doesn't name that page as its own.
    </p>
    <p>
      Both directions have to agree: your page points at your feed, and your feed's
      <code>&lt;channel&gt;&lt;link&gt;</code> points back at your page. It's the rule
      that stops anyone listing your feed under their URL. ${guide('#channel-link')}
      shows both halves.
    </p>`,
  }),

  no_linkback: ({ result, config }) => ({
    heading: "We couldn't find a link back to us",
    body: html`<p>
      <code>${result.url}</code> loaded and we found your feed &mdash; but that page has
      no link to <code>${new URL(config.siteUrl).host}</code>. That link is the whole
      consent mechanism: it's how we know you want to be listed.
    </p>
    <p>
      A plain text link counts exactly as much as the badge &mdash; we look at the
      <code>href</code>, not the picture. <a href="/badge">Grab a snippet</a>, put it on
      that page, and submit again.
    </p>
    ${
      result.submittedUrl && result.submittedUrl !== result.url
        ? html`<p class="panel__aside">
          Note we checked <code>${result.url}</code>, not
          <code>${result.submittedUrl}</code> &mdash; your feed's
          <code>&lt;channel&gt;&lt;link&gt;</code> names the first one, so that's the page
          we'd list, and that's the page the link has to be on.
        </p>`
        : ''
    }`,
  }),

  ambiguous_identity: ({ result }) => ({
    heading: 'That feed is already listed under a different page',
    body: html`<p>
      <code>${result.feedUrl}</code> is on the list already, under another URL, and that
      page still looks live to us. One feed gets one listing &mdash; the list we publish
      is a subscription list, so its unit is the feed.
    </p>
    <p>
      If you've moved your site and that old page is yours, take the feed link off it and
      submit again, or use the contact address on <a href="/about">the about page</a>.
      A person will sort it out.
    </p>`,
  }),

  domain_cap: ({ result }) => ({
    heading: 'That domain has reached its limit',
    body: html`<p>
      We cap how many listings one domain can hold
      ${result.domain ? html`(<code>${result.domain}</code>)` : ''} so a single site
      can't crowd out the directory. If you're a shared host with many genuine authors,
      say so via <a href="/about">the about page</a> &mdash; raising the cap for a host
      is a one-line change and we've done it for the obvious ones already.
    </p>`,
  }),

  daily_cap: () => ({
    heading: "We've hit today's limit for new listings",
    body: html`<p>
      Nothing is wrong with your site. This is a flood brake, it resets daily, and your
      submission will go through tomorrow.
    </p>`,
  }),

  rate_limited: ({ result }) => ({
    heading: 'Give it a minute',
    body: html`<p>
      Every submission means we fetch someone else's server a few times, so there's a
      limit on how often. Try again
      ${
        result.retryAfterSeconds
          ? html`in about ${Math.max(1, Math.ceil(result.retryAfterSeconds / 60))} minute(s)`
          : 'shortly'
      }.
    </p>`,
  }),

  cross_origin: () => ({
    heading: 'That submission came from somewhere else',
    body: html`<p>
      Submissions have to come from a form on this site. If you got here by following a
      link from another page, <a href="/submit">start again here</a>.
    </p>`,
  }),

  error: () => ({
    heading: 'Something went wrong on our end',
    body: html`<p>
      That's ours, not yours. Try again in a minute; if it keeps happening, the contact
      address on <a href="/about">the about page</a> reaches a person.
    </p>`,
  }),
};
