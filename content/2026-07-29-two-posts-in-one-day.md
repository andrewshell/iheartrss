---
title: Two posts in one day
time: 18:05
---
This is the second post dated 29 July, which is the point of it. Posts here are
markdown files named by date, and the date alone is enough when there is one post:

```
content/2026-07-29.md                    → /blog/2026/07/29
content/2026-07-29-two-posts-in-one-day.md  → /blog/2026/07/29/two-posts-in-one-day
```

The optional slug shipped on day one rather than the day it was first needed, because
the day you want two posts is the day every existing URL would otherwise have to
change. Two lines of regex now, no broken links later. Same reasoning as publishing a
feed before there was anything in it.

If you want to see what a feed reader gets from this, the raw markdown of every post
travels alongside the rendered HTML in [our feed](https://iheartrss.com/feed.xml):

```xml
<item>
  <title>Two posts in one day</title>
  <link>https://iheartrss.com/blog/2026/07/29/two-posts-in-one-day</link>
  <guid isPermaLink="true">https://iheartrss.com/blog/2026/07/29/two-posts-in-one-day</guid>
  <pubDate>Wed, 29 Jul 2026 18:05:00 GMT</pubDate>
  <description>&lt;p&gt;This is the second post dated 29 July…&lt;/p&gt;</description>
  <source:markdown>This is the second post dated 29 July…</source:markdown>
</item>
```

`source:markdown` is from the [source namespace](https://source.scripting.com/) —
the same namespace we look for when we check other people's feeds, and one of the two
badges you can earn on [the members page](https://iheartrss.com/sites). It costs us nothing to include: we
are holding the source text anyway.
