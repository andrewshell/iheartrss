---
title: Hello, and why this exists
time: 15:20
---
There are more good personal blogs now than at any point in the last decade, and
finding them is harder than it was. The search engines optimised for something else,
the social feeds optimised for something else again, and the thing that used to do
this job — one person's blogroll pointing at another's — quietly stopped being part
of how sites are built.

So: **iheartrss.com is a directory of people who love RSS.** Put the badge on your
homepage, submit your URL, and once we have checked that the link back exists and
found your feed, you are on the list. The list is published as
[an OPML subscription list](/subscriptions.opml) that any reader can subscribe to in
one action. Not a page of links you have to click through one at a time — a file your
reader understands.

The link-back requirement is the whole design. It means every listing is mutual: you
said you wanted to be here, on your own site, in public. Nobody gets added by a
crawler, and nobody has to trust us to keep a list honest, because the evidence is on
your page where anyone can check it. Take the link down and you are gone within a
week, no email required.

A few things we decided early, and will keep saying out loud:

- **RSS 2.0 only.** Not because Atom is bad — it is a fine format — but because the
  ecosystem we want to plug into speaks 2.0, and "we accept everything" is how a
  directory ends up unable to promise anything. [The guide](/guide) explains how to
  publish an RSS 2.0 feed on every common platform.
- **No accounts, no email, no cookies** except the one that logs the admin in. What
  we store is on [the about page](/about), in plain language, including exactly what
  we do with your IP address (hash it, truncated and keyed, and throw the record away
  after 90 days).
- **Everything readable as a feed.** Including this blog, which you can find at
  [/feed.xml](/feed.xml). A site about loving RSS that did not publish one would be
  a bad joke.

If you have been meaning to start a blog again, this is your excuse. Publish a feed,
add the badge, and let us point some people at you.
