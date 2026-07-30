import { html } from 'hono/html';

import { layout } from './layout.js';
import { submitForm } from './submit.js';

export function homePage({ config }) {
  const badgeImg = new URL('/iheartrss.svg', config.siteUrl).href;

  const body = html`
<section class="hero">
  <h1>I &hearts; RSS</h1>
  <p class="lede">
    A directory of people who love RSS. Put the badge on your homepage, submit your
    URL, and — once we&rsquo;ve checked the link back and found your feed — you&rsquo;re
    on the list, and in an OPML subscription list any reader can subscribe to.
  </p>
</section>

<section class="how">
  <h2>How to join</h2>
  <ol class="steps">
    <li>
      <h3>Put the badge on your homepage</h3>
      <p>
        Link to <code>https://iheartrss.com/</code>. An image badge or a plain text
        link both count &mdash; we look at the link, not the picture.
      </p>
      <p>
        <a href="/"><img src="${badgeImg}" alt="I love RSS" width="88" height="31"></a>
      </p>
      <p><a href="/badge">Get the badge and copy-paste snippets &rarr;</a></p>
    </li>
    <li>
      <h3>Make sure your feed is discoverable</h3>
      <p>
        We look for an RSS 2.0 feed advertised in your page&rsquo;s
        <code>&lt;head&gt;</code>.
      </p>
      <p><a href="/guide">How to publish an RSS 2.0 feed &rarr;</a></p>
    </li>
    <li>
      <h3>Submit your URL</h3>
      ${submitForm()}
    </li>
  </ol>
</section>
`;

  return layout({
    title: null,
    description:
      'A directory for people who love RSS. Add the badge, submit your site, get listed in a public OPML subscription list.',
    body,
    config,
  });
}
