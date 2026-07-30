import { html } from 'hono/html';

import { layout } from './layout.js';

/**
 * `/guide` — how to add an RSS 2.0 feed, per platform (plan §6.2).
 *
 * The counterpart to the RSS-2.0-only decision, and the page that keeps it from
 * being a closed door. Linked from every `feed_not_rss2` and
 * `feed_not_declared_on_canonical` rejection, from `/badge` and from `/about`.
 *
 * Static content, no server logic. The goal is stated in §6.2 and worth keeping in
 * view while editing: **someone rejected at 9pm is listed by 9:10, without switching
 * tools.** Shortest path to working first, explanation second.
 *
 * Every code block sits in its own container so a long line scrolls inside itself
 * rather than making the page scroll sideways (§6.3).
 */
export function guidePage({ config }) {
  const body = html`
<section class="guide">
  <h1>How to publish an RSS 2.0 feed</h1>
  <p class="lede">
    We list RSS 2.0 feeds only, and that&rsquo;s our constraint, not a judgement about
    yours. This page is the shortest path from &ldquo;we found a feed, just not an RSS
    2.0 one&rdquo; to being listed &mdash; on most platforms it&rsquo;s a five-minute
    change, and you keep your existing feed.
  </p>

  <nav class="guide__toc" aria-label="On this page">
    <ul>
      <li><a href="#autodiscovery">The autodiscovery tag</a></li>
      <li><a href="#channel-link">The <code>&lt;channel&gt;&lt;link&gt;</code></a></li>
      <li><a href="#jekyll">Jekyll / GitHub Pages</a></li>
      <li><a href="#eleventy">Eleventy</a></li>
      <li><a href="#zola">Zola</a></li>
      <li><a href="#astro">Astro</a></li>
      <li><a href="#template">Hand-rolled: a complete template</a></li>
    </ul>
  </nav>

  <h2 id="autodiscovery">The autodiscovery tag</h2>
  <p>
    This is how we (and every reader) find your feed. One line in your
    <code>&lt;head&gt;</code>:
  </p>
  <pre class="code"><code>&lt;link rel="alternate" type="application/rss+xml"
      title="Your site name" href="/feed.xml"&gt;</code></pre>
  <p>
    <strong>The non-obvious part:</strong> it has to be on
    <em>the page your feed&rsquo;s <code>&lt;channel&gt;&lt;link&gt;</code> points
    at</em>. If your feed says it belongs to <code>https://example.com/</code>, then
    <code>https://example.com/</code> is the page that needs this tag &mdash; not just
    your blog index, and not only your post pages. That&rsquo;s the page we list, so
    that&rsquo;s the page we read.
  </p>
  <p>
    <code>type="application/rss+xml"</code> exactly. <code>text/xml</code> and
    <code>application/atom+xml</code> are the two spellings that get sites rejected
    here.
  </p>
  <p>
    If your page advertises several feeds, we take the first RSS 2.0 one. Put the one
    you want listed first.
  </p>

  <h2 id="channel-link">The <code>&lt;channel&gt;&lt;link&gt;</code></h2>
  <p>
    Inside your feed, <code>&lt;channel&gt;&lt;link&gt;</code> names the site the feed
    belongs to. <strong>A wrong value here is the single most confusing rejection we
    produce</strong>, because everything looks fine from where you&rsquo;re standing.
  </p>
  <pre class="code"><code>&lt;channel&gt;
  &lt;title&gt;Your site name&lt;/title&gt;
  &lt;link&gt;https://example.com/&lt;/link&gt;
  &lt;description&gt;What you write about&lt;/description&gt;</code></pre>
  <p>
    It should be your site &mdash; usually your homepage or your blog index &mdash; not
    the feed&rsquo;s own URL, and not the URL of your most recent post. We publish that
    value as your listing, and we check the two point at each other: your page declares
    your feed, and your feed names your page. That mutual check is what stops anyone
    listing your feed under their own URL.
  </p>

  <h2 id="jekyll">Jekyll / GitHub Pages</h2>
  <p>
    <code>jekyll-feed</code> gives you Atom at <code>/feed.xml</code>. Keep it, and add
    RSS 2.0 alongside. Create <code>rss.xml</code> in your site root:
  </p>
  <pre class="code"><code>---
layout: null
---
&lt;?xml version="1.0" encoding="UTF-8"?&gt;
&lt;rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"&gt;
  &lt;channel&gt;
    &lt;title&gt;{{ site.title | xml_escape }}&lt;/title&gt;
    &lt;link&gt;{{ site.url }}{{ site.baseurl }}/&lt;/link&gt;
    &lt;description&gt;{{ site.description | xml_escape }}&lt;/description&gt;
    &lt;language&gt;en&lt;/language&gt;
    &lt;lastBuildDate&gt;{{ site.time | date_to_rfc822 }}&lt;/lastBuildDate&gt;
    &lt;atom:link href="{{ site.url }}{{ site.baseurl }}/rss.xml"
               rel="self" type="application/rss+xml" /&gt;
    {% for post in site.posts limit:20 %}
    &lt;item&gt;
      &lt;title&gt;{{ post.title | xml_escape }}&lt;/title&gt;
      &lt;link&gt;{{ site.url }}{{ post.url }}&lt;/link&gt;
      &lt;guid isPermaLink="true"&gt;{{ site.url }}{{ post.url }}&lt;/guid&gt;
      &lt;pubDate&gt;{{ post.date | date_to_rfc822 }}&lt;/pubDate&gt;
      &lt;description&gt;{{ post.content | xml_escape }}&lt;/description&gt;
    &lt;/item&gt;
    {% endfor %}
  &lt;/channel&gt;
&lt;/rss&gt;</code></pre>
  <p>Then add the tag to your layout&rsquo;s <code>&lt;head&gt;</code>:</p>
  <pre class="code"><code>&lt;link rel="alternate" type="application/rss+xml"
      title="{{ site.title }}" href="{{ '/rss.xml' | absolute_url }}"&gt;</code></pre>
  <p>
    <code>site.url</code> must be set in <code>_config.yml</code> &mdash; without it
    every link in the feed comes out relative, and <code>&lt;channel&gt;&lt;link&gt;</code>
    comes out empty.
  </p>

  <h2 id="eleventy">Eleventy</h2>
  <p>
    <code>@11ty/eleventy-plugin-rss</code> ships an RSS 2.0 sample alongside the Atom
    one. Copy <code>feed.njk</code> from the plugin&rsquo;s sample templates, choose the
    RSS 2.0 variant, and point <code>permalink</code> at <code>/rss.xml</code>. Set
    <code>metadata.url</code> in your data file &mdash; the plugin builds
    <code>&lt;channel&gt;&lt;link&gt;</code> from it. Then add the
    <a href="#autodiscovery">autodiscovery tag</a> to your base layout.
  </p>

  <h2 id="zola">Zola</h2>
  <p>In <code>config.toml</code>:</p>
  <pre class="code"><code>generate_feeds = true
feed_filenames = ["rss.xml"]
base_url = "https://example.com"</code></pre>
  <p>
    Zola ships a built-in <code>rss.xml</code> template and switches to it based on the
    filename, so this is usually the whole change. <code>base_url</code> is what becomes
    <code>&lt;channel&gt;&lt;link&gt;</code>. Zola inserts the autodiscovery tag itself
    if your template calls <code>{% block extra_head %}</code>; check the rendered
    <code>&lt;head&gt;</code>.
  </p>

  <h2 id="astro">Astro</h2>
  <p>
    <code>@astrojs/rss</code> already emits RSS 2.0, so this is usually just the missing
    <code>&lt;head&gt;</code> link. Confirm <code>site</code> is set in
    <code>astro.config.mjs</code> &mdash; the <code>rss()</code> helper builds
    <code>&lt;channel&gt;&lt;link&gt;</code> from it and silently omits it otherwise:
  </p>
  <pre class="code"><code>export default defineConfig({ site: 'https://example.com' });</code></pre>
  <p>Then in your layout:</p>
  <pre class="code"><code>&lt;link rel="alternate" type="application/rss+xml"
      title="Your site" href={new URL('rss.xml', Astro.site)} /&gt;</code></pre>

  <h2 id="template">Hand-rolled: a complete template</h2>
  <p>
    A minimal, valid RSS 2.0 document. Fill in the five values, keep the structure, and
    it will pass. You can also
    <a href="/rss-2.0-template.xml">download it</a>.
  </p>
  <pre class="code"><code>&lt;?xml version="1.0" encoding="UTF-8"?&gt;
&lt;rss version="2.0"&gt;
  &lt;channel&gt;
    &lt;title&gt;Your site name&lt;/title&gt;
    &lt;link&gt;https://example.com/&lt;/link&gt;
    &lt;description&gt;What you write about&lt;/description&gt;
    &lt;language&gt;en&lt;/language&gt;
    &lt;item&gt;
      &lt;title&gt;My first post&lt;/title&gt;
      &lt;link&gt;https://example.com/first-post&lt;/link&gt;
      &lt;guid isPermaLink="true"&gt;https://example.com/first-post&lt;/guid&gt;
      &lt;pubDate&gt;Mon, 27 Jul 2026 09:00:00 +0000&lt;/pubDate&gt;
      &lt;description&gt;A sentence or two, or the whole post.&lt;/description&gt;
    &lt;/item&gt;
  &lt;/channel&gt;
&lt;/rss&gt;</code></pre>
  <p>
    <code>&lt;pubDate&gt;</code> is RFC 822, which is the one format people get wrong;
    <code>date -R</code> prints it. A feed with a valid channel and no items at all is
    fine by us &mdash; you can add the feed before you have posts.
  </p>

  <h2>Read, fix, verify, submit</h2>
  <p>
    <a href="/submit">Test your page without listing it</a> &mdash; the second button on
    the form runs exactly the same checks and stores nothing. Then submit for real.
  </p>
</section>`;

  return layout({
    title: 'How to publish an RSS 2.0 feed',
    description:
      'Per-platform instructions for publishing an RSS 2.0 feed: Jekyll, Eleventy, Zola, Astro, or hand-rolled.',
    body,
    config,
  });
}
