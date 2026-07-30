import { html } from 'hono/html';

import { layout } from './layout.js';

export function notFoundPage({ config }) {
  const body = html`
<h1>404 &mdash; not here</h1>
<p>
  There&rsquo;s nothing at that address. It may have moved, or it may never have
  existed &mdash; hard to say from here.
</p>
<ul>
  <li><a href="/">Start from the homepage</a></li>
  <li><a href="/badge">Get the badge</a></li>
  <li><a href="/about">About this site</a></li>
  <li><a href="/feed.xml">Subscribe to the feed</a></li>
</ul>
`;

  return layout({ title: '404', body, config });
}
