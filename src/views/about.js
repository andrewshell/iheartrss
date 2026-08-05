import { html } from 'hono/html';

import { FEEDLAND_SERVER } from '../lib/feedland.js';
import { USER_AGENT } from '../lib/useragent.js';
import { layout } from './layout.js';

/**
 * The one address, and the reason it is a constant here rather than repeated inline.
 *
 * Four rejection messages (`banned`, `ambiguous_identity`, `domain_cap`, `error`) and
 * both halves of this page point at "the contact address on the about page" — so this
 * page is the single place it can live, and every one of those messages is a dead end
 * until it does. `banned` is the sharpest case: it is the one message with nothing for
 * the reader to fix, and an address is the entire remedy it offers.
 *
 * Not in `config`: it is not deployment-varying the way `SITE_URL` is, and a
 * `CONTACT_EMAIL` env var nobody sets would make an unconfigured deploy publish an
 * empty `mailto:` — the failure this constant exists to prevent.
 */
const CONTACT = 'andrew@iheartrss.com';

const contactLink = html`<a href="mailto:${CONTACT}">${CONTACT}</a>`;

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
  <pre class="code"><code>${USER_AGENT}</code></pre>
  <p>
    If we are being blocked, we mark the listing as blocked rather than dropping it
    &mdash; being behind a bot filter should not cost anyone their place on the list.
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
      <strong>Email ${contactLink}</strong> and we will remove the listing straight away,
      no questions and no account required.
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
    <strong>Two pages load other people&rsquo;s code, and it is worth being plain
    about that.</strong> The homepage runs Dave Winer&rsquo;s blogroll software in
    place of our own reader, and <a href="/river">the river</a> runs FeedLand&rsquo;s
    river display. Your browser fetches both &mdash; along with jQuery, Bootstrap and
    Font Awesome &mdash; from <code>scripting.com</code>&rsquo;s files on Amazon S3,
    and then asks <a href="${FEEDLAND_SERVER}/">${new URL(FEEDLAND_SERVER).host}</a>
    for the member feeds and their latest items. Those two hosts see your IP address
    and which of our two pages you loaded.
  </p>
  <p>
    <strong>The river also loads images from the sites it is showing you.</strong>
    Each feed is listed with its site&rsquo;s favicon, which comes from
    <a href="https://duckduckgo.com/">DuckDuckGo&rsquo;s</a> icon service &mdash; so
    <code>icons.duckduckgo.com</code> is told which member domains have items in the
    river you are reading. And where a post contains a picture, your browser fetches
    it from wherever that author keeps it, which means
    <strong>a member&rsquo;s server can see your IP address when their post appears
    in the river</strong>. That is how the pictures get there, and it is the one place
    on this site where we cannot tell you in advance who is being contacted &mdash; it
    is whoever published the post you are reading.
  </p>
  <p>
    If you would rather that did not happen, blocking images on this page costs you
    nothing else: the river is text first, and every headline links to the post at
    the source. Nothing else on either page is fetched from anywhere else, and the
    fonts, the stylesheet and our own icons are all served from here.
  </p>
  <p>
    Those two pages are the only ones it happens on. Every other page here makes no
    third-party requests at all. Nobody in that list is asked to track you,
    we run no analytics, and browsing this site sets no cookies.
  </p>
</section>

<section>
  <h2>Reporting a listed site</h2>
  <p>
    If a listed site is spam, malware, or otherwise should not be here, report it and we will
    look at it. Anything listed can be hidden, and any domain can be banned.
    <a href="/report">Use the report form</a>, or email ${contactLink} &mdash; both reach a
    person.
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
