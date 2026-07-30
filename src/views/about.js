import { html } from 'hono/html';

import { layout } from './layout.js';

export function aboutPage({ config }) {
  const body = html`
<h1>About I &hearts; RSS</h1>

<section>
  <h2>What this is</h2>
  <p>
    <a href="${config.siteUrl}">iheartrss.com</a> is a directory of people who love RSS.
    Someone puts an &ldquo;I &hearts; RSS&rdquo; link on their homepage and submits their
    URL. We check that the link really is there and that the site publishes a discoverable
    RSS 2.0 feed, and then we add it to a public list and to an OPML subscription list that
    any OPML-aware feed reader can subscribe to.
  </p>
  <p>
    If you found this URL in your server logs, it is almost certainly because someone
    submitted your site &mdash; possibly you.
  </p>
</section>

<section>
  <h2>What we fetch, and how often</h2>
  <p>We fetch two things, and only two things:</p>
  <ul>
    <li>Your page, to look for the link back to us and for your feed&rsquo;s
      <code>&lt;link rel="alternate"&gt;</code> tag.</li>
    <li>Your feed, to check it is RSS 2.0 and to read its title and description.</li>
  </ul>
  <p>
    That is a handful of requests when a site is first submitted, and then the same handful
    again about <strong>once every six days</strong> when we re-check that listings are still
    good. We send conditional requests where we can, we obey a response size cap, and we
    never crawl beyond those two URLs. We do not follow links, we do not index your content,
    and we are not a search engine.
  </p>
  <p>
    If you would rather allowlist us in Cloudflare or a WAF than block us, our requests are
    identifiable by their <code>User-Agent</code>, which names this page:
  </p>
  <pre class="code"><code>iheartrss.com/1.0 (+${config.siteUrl}/about)</code></pre>
  <p>
    Our outbound source IP is published here once the service is deployed. If we are being
    blocked, we mark the listing as blocked rather than dropping it &mdash; being behind a
    bot filter should not cost anyone their place on the list.
  </p>
</section>

<section>
  <h2>How to be removed</h2>
  <p>Two ways, and the slow one needs nothing from you:</p>
  <ul>
    <li>
      <strong>Remove the link.</strong> Take the I &hearts; RSS link off your page and you
      will be gone within a week. We deliberately require two separate confirmations that
      the link is gone, several days apart, so that one bad afternoon &mdash; a deploy, an
      outage, a CDN error page &mdash; can never remove someone by accident. That is why it
      is not instant.
    </li>
    <li>
      <strong>Email us</strong> and we will remove the listing straight away, no questions
      and no account required.
    </li>
  </ul>
  <p>
    You can also ask us to never list a domain again, in which case future submissions of it
    are refused.
  </p>
</section>

<section>
  <h2>Why did my site vanish?</h2>
  <p>
    <a href="/status">The status page</a> answers it. Give it your URL &mdash; either the
    one you submitted or the one your feed names as its own &mdash; and it shows the
    state we have, when we last checked, and the last error we saw. There are no
    accounts here and we have no way to email you, so that page is how you ask.
  </p>
  <p>
    If the answer is that your feed isn&rsquo;t RSS 2.0, or that your page and your feed
    disagree about each other, <a href="/guide">the guide</a> has the fix per platform.
  </p>
</section>

<section>
  <h2>Privacy</h2>
  <p>
    Short and true. We store the URLs people submit. For each submission, we also store a
    <strong>truncated, keyed, daily-rotating hash of the submitter&rsquo;s IP address</strong>
    &mdash; the address is first truncated to a <code>/24</code> for IPv4 or a
    <code>/64</code> for IPv6, then hashed with HMAC-SHA256 under a key we hold and mixed
    with the current date. <strong>We never store raw IP addresses.</strong>
  </p>
  <p>
    That hash exists for exactly two purposes: rate limiting, so one person cannot flood the
    submission queue, and abuse triage, so that when something is being attacked we can tell
    whether it is one source or many. Because the key is ours and the date is mixed in, the
    hashes cannot be matched back to an address by anyone else, and yesterday&rsquo;s hashes
    do not line up with today&rsquo;s.
  </p>
  <p>
    <strong>Submission records are deleted after 90 days.</strong>
  </p>
  <p>
    <strong>One third party sees you: FeedLand.</strong> The reader on our homepage is
    served from this domain, but it asks
    <a href="https://feedland.com/">feedland.com</a> for the list of member feeds and
    for their latest items, and that request comes from your browser &mdash; so
    FeedLand sees your IP address and that you loaded our homepage. It is how the
    reader works, and we would rather say so than hide behind the fact that the script
    itself is ours.
  </p>
  <p>
    That is the only page it happens on. Every other page here makes no third-party
    requests at all. There are no analytics and no tracking of any kind, and browsing
    this site sets no cookies.
  </p>
</section>

<section>
  <h2>Reporting a listed site</h2>
  <p>
    If a listed site is spam, malware, or otherwise should not be here, report it and we will
    look at it. Anything listed can be hidden, and any domain can be banned.
    <a href="/report">Use the report form</a>, or email &mdash; both reach a person.
  </p>
</section>
`;

  return layout({
    title: 'About',
    description:
      'What iheartrss.com is, what it fetches from your site and how often, how to be removed, and what it stores about you.',
    body,
    config,
  });
}
