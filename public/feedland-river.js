/*
 * The river on /river, built on FeedLand's own `riverviewer.js` — the same display
 * https://wp.feedland.org/ runs, wired to OUR OPML file instead of a FeedLand
 * category.
 *
 * A "river" here is Dave Winer's sense of the word: every member's newest items in
 * one reverse-chronological stream, grouped into a section per feed-per-burst, with
 * the item text inline. That is the complement to the blogroll on `/`, which is a
 * list of *feeds* you open one at a time.
 *
 * ── What this file is not ─────────────────────────────────────────────────────
 *
 * wp.feedland.org drives its page through `riverclient/code.js`, whose `startup()`
 * reads two globals — `globalOutline` (an OPML outline with `tabs`/`style`/`script`
 * summits) and `userPrefs` — that describe a FeedLand *news product*: tabs, custom
 * CSS, a startup script, a logo, a tagline. We have none of that and want none of
 * it, so riverclient.js is deliberately NOT loaded. Two concrete reasons beyond
 * "we don't need it":
 *
 *   * **It would repoint every API call.** It defines its own `servercall` reading
 *     `appConsts.urlServerForClient`, and it loads after `feedland/home/api.js`, so
 *     the later definition wins. Our calls would go to whatever that field says
 *     rather than to `urlFeedlandServer` — a second host to keep in step with the
 *     CSP, for nothing.
 *   * **`startup()` would alert.** With no `globalOutline` it pops "Can't display
 *     the tabs because there is no outline summit named 'tabs.'" at the visitor.
 *
 * So this file calls `displayTraditionalRiver` directly. That is the one function
 * the whole display hangs off, and everything above it in Dave's stack is page
 * chrome we are replacing with our own.
 *
 * ── The OPML url goes to the SERVER, not to a parser here ──────────────────────
 *
 * `getRiver` (in `feedland/home/api.js`) branches on the shape of its first
 * argument, and a string ending in `.opml` becomes:
 *
 *     GET <feedland>/getriverfromopml?url=<our OPML>
 *
 * — FeedLand fetches our subscription list itself and returns the built river. The
 * alternative path, `viewRiverFromList`, downloads the OPML into the browser and
 * parses it with `opmlpackage/client/opml.js` to hand back an array of feed urls,
 * which reaches the same place having loaded another library and made another
 * request. Passing the url straight through is the same arrangement the blogroll
 * already uses, and it is why `connect-src` names FeedLand and nothing else.
 *
 * (The consequence is the same one `views/home.js` notes: FeedLand fetches the OPML
 * **server-side**, so a SITE_URL pointing at localhost cannot work. The river is
 * empty in development and only fills in on the deployed origin.)
 */

/**
 * The FeedLand host, if the page did not say.
 *
 * The page DOES say — `data-feedland` on the container, rendered from
 * `src/lib/feedland.js`, the same constant `connect-src` is built from. This literal
 * is the fallback for a page that forgets the attribute, and it is a second copy of
 * something that has one home, so `test/river.test.js` asserts it still equals
 * `FEEDLAND_SERVER`. A static file cannot import the constant; a test is the only
 * thing that can notice the drift.
 */
const DEFAULT_FEEDLAND = 'https://claude.feedland.org';

/**
 * **The trailing slash is required, and its absence is silent.**
 *
 * `servercall` builds its URL as `urlServer + path + "?" + params` — a bare
 * concatenation with no separator. Without the slash the request goes to
 * `https://claude.feedland.orggetriverfromopml`, which fails DNS, which arrives as
 * an error dialog with a message about a hostname rather than anything about a URL.
 *
 * The host comes from `lib/feedland.js`, where it is an ORIGIN with no trailing
 * slash — a CSP source expression must not carry a path. So the slash is added here,
 * at the one boundary that needs it. Same reasoning as `feedland-blogroll.js`.
 */
function withTrailingSlash(server) {
  return server.endsWith('/') ? server : `${server}/`;
}

/**
 * The globals the FeedLand includes look up by name. Both are `var` on purpose: they
 * are read by other classic scripts on the page, which is the same binding Dave's
 * own pages make.
 *
 * `appConsts` — `api.js` reads `urlFeedlandServer` on every call, and `misc.js` reads
 * `flUseTwitterIdentity` in `userIsSignedIn`. Setting it FALSE is what routes that
 * check to the email branch, which finds no `globals.emailMemory` and answers no —
 * so the like button hides itself and the bookmark button is never built. There is no
 * sign-in on this site and no way to make one of those work.
 *
 * `globals` — `misc.js` and `riverviewer.js` reach into it for a signed-in user's
 * subscriptions and bookmarks menu. Most of those reads are inside a `try`, but
 * `getBookmarkButton`'s is not, so an object that exists and is empty is the cheap
 * way to be sure a future code path finds "nothing here" rather than a
 * ReferenceError.
 */
var appConsts = {
  urlFeedlandServer: withTrailingSlash(DEFAULT_FEEDLAND),
  flUseTwitterIdentity: false,
};

var globals = {};

function startRiver() {
  const container = document.getElementById('idRiverContainer');
  // Every page shares one layout; only /river has the container. The script is opted
  // into per page, but a missing element must be a no-op rather than a thrown error
  // if that ever slips.
  if (container === null) return;

  appConsts.urlFeedlandServer = withTrailingSlash(
    container.dataset.feedland || DEFAULT_FEEDLAND,
  );

  watchImages(container);
  watchExpandClicks(container);

  // eslint-disable-next-line no-undef -- jQuery, loaded by the includes in `<head>`
  const $ = window.jQuery;

  // eslint-disable-next-line no-undef -- from feedland/home/riverviewer.js
  displayTraditionalRiver(
    container.dataset.opmlurl,
    // A jQuery object, not the element: the river appends to it with `.append`.
    $(container),
    undefined, //screenname — an account concept, and there is no account here
    function (err) {
      riverFinished(container, err);
    },
  );

  // The relative times ("2 hours ago") on every item, kept honest. `runEveryMinute`
  // is from `basic/code.js` and fires on the minute rather than 60s after load.
  //
  // Dave's `startup()` ALSO runs `riverItemsEverySecond` on a 1s interval. We do not,
  // and it costs nothing: that path exists only to re-measure the "more" button, and
  // `riverviewer.js` opens with `const flMoreButtonVisible = false`, which makes the
  // whole handler a no-op. It would be one forced layout per item per second to
  // decide to do nothing.
  //
  // eslint-disable-next-line no-undef -- from includes/basic/code.js
  runEveryMinute(riverItemsEveryMinute);
}

/**
 * Swap the standing "Loading…" line for whatever actually happened.
 *
 * The line has to start in the HTML rather than be written here, because the slow
 * case is exactly the case where this script has not run yet: FeedLand is building a
 * river across ~150 feeds and the page is otherwise an empty box under a heading.
 *
 * On failure it stays and says so. `displayTraditionalRiver` already puts up its own
 * Bootstrap alert on a server error, but that is a dialog someone dismisses — once it
 * is gone the page would be an empty box with no explanation, which reads as our bug
 * rather than as an outage.
 *
 * **The failure text carries real links**, because this paragraph is the only thing
 * on the page outside the river container: there is no standing prose above it to
 * fall back to any more, so a visitor who arrives during an outage has nowhere to go
 * unless it is said here.
 *
 * Built with `createElement` rather than `innerHTML`. Nothing here is
 * attacker-controlled — it is four literals in this file — so the choice is not about
 * this string being dangerous. It is that `innerHTML` on a page that has already
 * conceded `style-src 'unsafe-inline'` is the habit worth not having, and the DOM
 * calls are no longer to write.
 */
function riverFinished(container, err) {
  const note = document.getElementById('idRiverStatus');
  if (note === null) return;

  if (err === undefined) {
    note.remove();
    markClippedItems(container);
    return;
  }

  note.textContent = '';
  note.appendChild(document.createTextNode('The river could not be loaded just now. '));
  note.appendChild(link('/sites', 'The member list'));
  note.appendChild(document.createTextNode(' and the '));
  note.appendChild(link('/subscriptions.opml', 'OPML file'));
  note.appendChild(
    document.createTextNode(' have the same feeds, and any reader can follow them.'),
  );
  note.classList.add('river__status--error');
}

/**
 * Two things that can only be known once an image has settled, on one pair of
 * listeners.
 *
 * Both are in the CAPTURE phase, and that is load-bearing: neither `load` nor `error`
 * bubbles, so a listener registered the ordinary way would never see them. Capture is
 * the only way to catch an event from an element that does not exist yet — and none
 * of these images do, because riverviewer.js creates them itself as each feed's info
 * arrives, long after this runs. Per-image handlers are not available to us.
 *
 * **On `error` — hide the favicon.** `getUrlIconImage` asks
 * `icons.duckduckgo.com/ip3/<domain>.ico` for every feed and emits the `<img>` with no
 * `alt`, so a domain DuckDuckGo has no icon for renders the browser's broken-image
 * glyph next to the site's name. That was one section of 145 on our list the day this
 * was written, and it reads as a broken page rather than as a missing icon — the row
 * beside it is fine, so the eye blames us. Scoped to favicons by class: an item's own
 * picture failing is the author's business and their `alt` text should show.
 *
 * **On `load` — re-measure the clip.** An item's own picture changes the height of
 * the body it sits in, and it lands after `markClippedItems` has already run. Without
 * this, an item that only overflows *because* of its picture never gets its fade.
 * Re-measured for that one body rather than the whole river, so a page of 174 items
 * does not re-measure all of them once per image.
 *
 * Both set a CLASS rather than touching `style`, so every presentational decision
 * stays in `style.css`. (Inline styles would work — this page concedes
 * `style-src 'unsafe-inline'` for the FeedLand includes — but leaning on that
 * concession in our own code is how it stops being possible to remove.)
 */
function watchImages(container) {
  container.addEventListener(
    'error',
    function (event) {
      const target = event.target;
      if (target.classList && target.classList.contains('imgFavIcon')) {
        target.classList.add('river-favicon--missing');
      }
    },
    true,
  );

  container.addEventListener(
    'load',
    function (event) {
      const body = event.target.closest && event.target.closest('.divRiverItemBody');
      if (body !== null && body !== undefined) markOneItem(body);
    },
    true,
  );
}

/**
 * Flag the item bodies that `max-height` is actually cutting off, so the stylesheet
 * can fade only those.
 *
 * CSS has no way to ask "did this overflow?", so the question has to be answered here
 * and answered as a class. Without it the fade would sit over every item, including
 * the two-line posts that are showing in full — a gradient promising more text that
 * does not exist.
 *
 * This is the same measurement `riverviewer.js`'s own `setupMoreButton` makes, and it
 * is here because that function cannot be reached: the file opens with
 * `const flMoreButtonVisible = false`, so it returns without doing anything and there
 * is no way to switch it back on from outside.
 */
function markClippedItems(container) {
  const bodies = container.querySelectorAll('.divRiverItemBody');
  for (const body of bodies) markOneItem(body);
}

function markOneItem(body) {
  // A body the reader has OPENED is never re-measured. With the cap lifted its
  // scrollHeight and clientHeight are equal by definition, so measuring it would
  // clear the very class that lets it be closed again — and an image finishing its
  // load is enough to trigger that.
  if (body.classList.contains('river-item--expanded')) return;

  // The 1px tolerance is for sub-pixel line heights, which otherwise report a
  // one-pixel overflow on items that are plainly not clipped.
  const clipped = body.scrollHeight > body.clientHeight + 1;
  body.classList.toggle('river-item--clipped', clipped);

  // Reachable and announced only while there is something to open. `tabindex` rather
  // than `role="button"`: the body contains links, and a button may not.
  if (clipped) {
    body.setAttribute('tabindex', '0');
    body.setAttribute('aria-expanded', 'false');
  } else {
    body.removeAttribute('tabindex');
    body.removeAttribute('aria-expanded');
  }
}

/**
 * Click a cut-off item to open it, click again to close it — the behaviour
 * scripting.com's river has, which ours had only half of.
 *
 * **Why this is ours and not Dave's.** `riverviewer.js` already has the toggle, on a
 * MORE button, and neither half of it can work here:
 *
 *   * The button is never shown. `setupMoreButton` is what would reveal it, and the
 *     file opens with `const flMoreButtonVisible = false`, so it returns immediately.
 *     A top-level `const` in someone else's classic script cannot be reassigned.
 *   * Its collapse branch cannot collapse. Expanding does
 *     `css("max-height", scrollHeight)` — a number, so jQuery appends `px` and it
 *     works. Closing does `css("max-height", "200")` — a STRING, which jQuery passes
 *     through untouched, producing the same unitless `max-height: 200` that is
 *     invalid in his stylesheet. The browser discards it and keeps the expanded
 *     value, so the item opens once and stays open forever.
 *
 * That second handler still runs before this one, because it is bound on the body
 * itself and this listener is on the container in the BUBBLE phase — deeper handlers
 * go first. That ordering is deliberate: it means his inline `max-height` is already
 * written by the time we get here, and clearing it is the last word. (Capture phase
 * would run first and be immediately overwritten.)
 *
 * Removing an inline style someone else set is the one place this file touches
 * `style` at all — it is not us styling in JS, it is us undoing it.
 */
function watchExpandClicks(container) {
  container.addEventListener('click', function (event) {
    const body = closestBody(event.target);
    if (body === null) return;

    // A link is a link. Opening someone's post must never be intercepted by the
    // expander sitting underneath it.
    if (event.target.closest('a') !== null) return;

    // Someone selecting a sentence is reading, not toggling.
    const selection =
      window.getSelection === undefined ? '' : String(window.getSelection());
    if (selection.length > 0) return;

    toggleItem(body);
  });

  container.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;

    const body = closestBody(event.target);
    // Only when the body ITSELF has focus — Enter on a link inside it must follow the
    // link, and Space must still scroll the page from anywhere else.
    if (body === null || body !== event.target) return;

    event.preventDefault();
    toggleItem(body);
  });
}

/** The item body an event came from, if it is one that can open at all. */
function closestBody(target) {
  if (target === null || target.closest === undefined) return null;

  const body = target.closest('.divRiverItemBody');
  if (body === null) return null;

  // `--clipped` is the fact that it overflows; `--expanded` is the reader's choice.
  // An open item keeps only the second, so both have to count as toggleable.
  const classes = body.classList;
  if (
    !classes.contains('river-item--clipped') &&
    !classes.contains('river-item--expanded')
  ) {
    return null;
  }
  return body;
}

function toggleItem(body) {
  // riverviewer.js's handler has already written its own `max-height` inline by now.
  // Clearing it hands the height back to the stylesheet, which is the only place that
  // knows both states.
  body.style.maxHeight = '';

  const expanded = body.classList.toggle('river-item--expanded');
  body.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

function link(href, text) {
  const anchor = document.createElement('a');
  anchor.setAttribute('href', href);
  anchor.textContent = text;
  return anchor;
}

startRiver();
