/*
 * Mark every off-site link inside a container `rel="nofollow ugc"`.
 *
 * The blogroll and the river are River's custom elements, which build their links in
 * the browser, after load and again whenever an update arrives, so the only place to
 * add the tokens is on the live DOM. River's elements render into the page's own DOM,
 * not a shadow root, so a MutationObserver on the element sees every link. Listing a site here must not pass it link equity,
 * or the directory becomes worth joining for SEO spam.
 *
 * `relList.add` keeps whatever tokens were already there (`noopener`, say) and does
 * nothing for a token already present, so re-marking an anchor is harmless.
 */
function nofollowMemberLinks(container) {
  function isOffSite(href) {
    let url;
    try {
      url = new URL(href, location.href);
    } catch {
      return false;
    }
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin !== location.origin
    );
  }

  function markAll() {
    for (const anchor of container.querySelectorAll('a[href]')) {
      const rel = anchor.relList;
      if (rel.contains('nofollow') && rel.contains('ugc')) continue;
      if (isOffSite(anchor.href)) rel.add('nofollow', 'ugc');
    }
  }

  markAll();

  // Only `href` is watched among attributes, so the `rel` writes above cannot
  // re-trigger this observer.
  new MutationObserver(markAll).observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href'],
  });
}

// Deferred, so the elements are parsed by the time this runs, whether or not River's
// modules have upgraded them yet.
for (const element of document.querySelectorAll('river-blogroll, river-river')) {
  nofollowMemberLinks(element);
}
