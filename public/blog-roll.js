/**
 * Is this a date we can actually render?
 *
 * FeedLand omits `whenUpdated` entirely on a feed it has never crawled — not null,
 * not an empty string, absent — and `new Date(undefined)` is an Invalid Date whose
 * `getTime()` is NaN. Every date this file touches goes through here first, because
 * the alternative is discovering it downstream as the word "undefined" on the page.
 */
function isRenderableDate(value) {
  const time = new Date(value).getTime();

  // `> 0`, not merely finite, and both halves are load-bearing:
  //
  //   * `new Date(undefined)` is an Invalid Date — NaN — which is the never-crawled
  //     feed described on `hasKnownUpdateTime`.
  //   * `new Date(null)` is the EPOCH, which is finite and would sail through a
  //     NaN-only check to render as "56 years ago". FeedLand also uses
  //     `1970-01-01T00:00:00.000Z` as a "never happened" sentinel outright — it is
  //     what `whenLastError` carries on a feed that has never errored — so the epoch
  //     has to be treated as absent here rather than as a very old post.
  return Number.isFinite(time) && time > 0;
}

function timeAgo(input) {
  const date = input instanceof Date ? input : new Date(input);
  const formatter = new Intl.RelativeTimeFormat('en', { style: 'short' });
  const ranges = [
    ['years', 3600 * 24 * 365],
    ['months', 3600 * 24 * 30],
    ['weeks', 3600 * 24 * 7],
    ['days', 3600 * 24],
    ['hours', 3600],
    ['minutes', 60],
    ['seconds', 1],
  ];
  const secondsElapsed = (date.getTime() - Date.now()) / 1000;

  for (const [rangeType, rangeVal] of ranges) {
    if (rangeVal < Math.abs(secondsElapsed)) {
      const delta = secondsElapsed / rangeVal;
      return formatter.format(Math.round(delta), rangeType);
    }
  }

  // Falling out of the loop means the gap is under a second — a post published
  // while the page was loading, and the case an unusable date also lands in. The
  // loop returning nothing put the string "undefined" on the page, because that is
  // what `textContent = undefined` renders.
  return isRenderableDate(date) ? 'just now' : '';
}

function compareDates(key, a, b) {
  const dateA = new Date(a[key]);
  const dateB = new Date(b[key]);
  return dateB - dateA;
}

function stripAndTruncate(htmlString, maxLength) {
  const tempElement = document.createElement('div');
  tempElement.innerHTML = htmlString;
  const text = tempElement.textContent || tempElement.innerText || '';

  if (text.length <= maxLength) {
    return text;
  }

  const truncated = text.slice(0, maxLength);
  const lastSpaceIndex = truncated.lastIndexOf(' ');

  // If there's a space to break at, truncate there, otherwise, truncate at maxLength
  const finalString =
    lastSpaceIndex !== -1 ? truncated.slice(0, lastSpaceIndex) : truncated;

  return finalString + '…';
}

/**
 * Has FeedLand actually crawled this feed yet?
 *
 * A member who joins the directory before FeedLand knows their feed comes back with
 * `ctItems: 0` — and `whenUpdated` stamped at the moment FeedLand *registered* the
 * feed rather than when anything was published. That combination puts the one feed
 * with nothing behind it at the very top of a list sorted newest-first: the reader's
 * first row reads "2 minutes ago" and opens to an empty list.
 *
 * Hiding it until the crawl lands costs the member nothing — they are in
 * /subscriptions.opml and on /sites from the moment they pass verification, which is
 * what being listed means — and the row appears on its own once there is something
 * for a visitor to click.
 *
 * A missing or unparseable count means "FeedLand didn't say", which shows the feed.
 * The failure direction matters: treating unknown as empty would blank the entire
 * reader the day that field is renamed.
 */
function hasBeenCrawled(feed) {
  const count = Number(feed?.ctItems);
  return Number.isFinite(count) ? count > 0 : true;
}

/**
 * Can this row say when the feed last changed?
 *
 * The companion to `hasBeenCrawled`, and NOT the same check — this is the one that
 * was missing. There is a second, distinct state a feed can be in: FeedLand has
 * never crawled it at all, and returns it with `ctItems`, `whenUpdated` and
 * `whenCreated` all absent. A live example on our own list:
 *
 *     John's World Wide Wall Display   ctItems=∅   whenUpdated=∅   whenCreated=∅
 *
 * `hasBeenCrawled` waves that through on purpose — an absent count means "FeedLand
 * didn't say", and failing open is right for a *count*. But the row then rendered
 * its time from an absent date, and shipped the literal string "undefined" to the
 * page. The count was never the field that mattered for rendering; this one is.
 *
 * Dave Winer's blogroll.js filters on exactly this — `theFeed.whenUpdated ===
 * undefined` drops the feed — which is how the difference was found.
 */
function hasKnownUpdateTime(feed) {
  return isRenderableDate(feed?.whenUpdated);
}

/**
 * Which FeedLand answers this reader, and how long we wait for it.
 *
 * **The server is a parameter, not a constant in the fetch line.** It was
 * `https://feedland.com` written into two URLs, which is the kind of thing that is
 * only wrong once and then very confusing: the site now talks to Dave Winer's
 * `claude.feedland.org`, so a restored reader would have quietly gone on asking a
 * different server than the rest of the page. It is settable per element via the
 * `server` attribute — but note that whatever it points at must ALSO be named in
 * `connect-src` in `src/lib/headers.js`, or the browser refuses the request. Two
 * places, unavoidably: a CSP cannot be derived from an attribute.
 *
 * The timeout exists because `fetch` has none. A FeedLand that accepts the
 * connection and then says nothing left the promise pending forever — the reader
 * never rendered and never gave up, with nothing in the console to say why.
 * blogroll.js passes 30s to jQuery for the same calls; this matches it.
 */
const DEFAULT_SERVER = 'https://claude.feedland.org';
const REQUEST_TIMEOUT_MS = 30000;

async function getFeedListFromOpml(url, server = DEFAULT_SERVER) {
  try {
    // Fetch the data from the API endpoint
    const response = await fetch(
      `${server}/getfeedlistfromopml?url=${encodeURIComponent(url)}`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );

    // Check if the response is successful
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Parse the JSON data
    const data = await response.json();

    // Return the parsed data, minus the feeds there is nothing to read behind yet
    // and the ones FeedLand cannot date. Both filters, because they catch different
    // states — see each function.
    return (data?.feedlist ?? [])
      .filter(hasBeenCrawled)
      .filter(hasKnownUpdateTime)
      .sort(compareDates.bind(null, 'whenUpdated'));
  } catch (error) {
    console.error('Error fetching feed list from OPML:', error);
    return [];
  }
}

async function getFeedItems(url, maxItems, server = DEFAULT_SERVER) {
  try {
    // Fetch the data from the API endpoint
    const response = await fetch(
      `${server}/getfeeditems?url=${encodeURIComponent(url)}&maxItems=${encodeURIComponent(maxItems)}`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );

    // Check if the response is successful
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Parse the JSON data
    const data = await response.json();

    // `pubDate` — when the post was published — and NOT `whenUpdated`, which on an
    // item is when FeedLand last touched the feed record it came from. See
    // `listItemElement`: sorting on `whenUpdated` here was very nearly a no-op,
    // because most items in one feed carry the identical value.
    return data.sort(compareDates.bind(null, 'pubDate'));
  } catch (error) {
    console.error('Error fetching feed list from OPML:', error);
    return [];
  }
}

/**
 * One item in an expanded feed.
 *
 * **The date is `pubDate`, not `whenUpdated`.** An item carries both, and they mean
 * different things: `pubDate` is when the post was published, `whenUpdated` is when
 * FeedLand last touched the *feed record* the item came from. The second is very
 * nearly a per-feed constant — five items from brennan.day spanning six days came
 * back with five distinct `pubDate`s and two distinct `whenUpdated`s — so reading it
 * per item stamped four posts with the same time, and none of them with their own.
 * blogroll.js reads `pubDate`, which is how the difference was found.
 *
 * The `datetime` attribute gets an ISO string rather than the raw value. FeedLand
 * sends RFC-822 here ("Fri, 31 Jul 2026 22:55:52 GMT"), which `new Date()` parses
 * happily but which is not a valid HTML datetime — so the attribute was invalid for
 * every item, whichever field it read.
 *
 * **The link falls back to the enclosure, and to no link at all.** A podcast item
 * routinely has no `<link>` — the episode audio is the `<enclosure>` — and this used
 * to render `href="undefined"`, a relative URL that resolves against our own origin
 * and 404s on iheartrss.com. blogroll.js has the same fallback. With neither, the
 * text is rendered as text: an item nobody can open is still an item worth listing,
 * and a link to nowhere is worse than no link.
 */
function itemUrl(item) {
  return item?.link ?? item?.enclosure?.url;
}

function listItemElement(item) {
  const url = itemUrl(item);
  const link = document.createElement(url === undefined ? 'span' : 'a');
  if (url !== undefined) link.setAttribute('href', url);
  link.textContent = stripAndTruncate(item.title || item.description, 100);

  const time = document.createElement('time');
  if (isRenderableDate(item.pubDate)) {
    time.setAttribute('datetime', new Date(item.pubDate).toISOString());
  }
  time.textContent = timeAgo(item.pubDate);

  const li = document.createElement('li');
  li.appendChild(link);
  li.appendChild(document.createTextNode(' - '));
  li.appendChild(time);

  return li;
}

async function detailsElement(feed, server = DEFAULT_SERVER) {
  const span = document.createElement('span');
  span.textContent = `${feed.title} - `;

  const time = document.createElement('time');
  time.setAttribute('datetime', feed.whenUpdated);
  time.textContent = timeAgo(feed.whenUpdated);

  const summary = document.createElement('summary');
  summary.appendChild(span);
  summary.appendChild(time);

  const details = document.createElement('details');
  details.appendChild(summary);
  // How a socket update finds this row again. `feedUrl` is the identity FeedLand
  // uses in both the feed list and its socket payloads, so it is the one to key on.
  details.setAttribute('data-feedurl', feed.feedUrl);

  details.addEventListener('toggle', (event) => {
    if (event.newState === 'open') {
      getFeedItems(feed.feedUrl, 5, server).then((items) => {
        let list = event.target.querySelector('ul');
        if (!list) {
          list = document.createElement('ul');
          event.target.appendChild(list);
        }
        list.innerHTML = '';
        items.forEach((item) => list.appendChild(listItemElement(item)));
      });
    }
  });

  return details;
}

/**
 * FeedLand's socket message format, which is not JSON.
 *
 * Each frame is a command, a CARRIAGE RETURN, then a JSON payload:
 *
 *     updatedFeed\r{"feedUrl":"https://…","title":"…","whenUpdated":"…"}
 *
 * Returns `undefined` for anything that does not parse — a keepalive, a command we
 * do not handle, a truncated frame. The socket is a live connection to someone
 * else's server and the page has already rendered without it, so nothing arriving
 * on it is allowed to throw.
 */
function parseSocketMessage(data) {
  const text = String(data ?? '');
  const separator = text.indexOf('\r');
  if (separator === -1) return undefined;

  try {
    return {
      command: text.slice(0, separator),
      payload: JSON.parse(text.slice(separator + 1)),
    };
  } catch {
    return undefined;
  }
}

/** `https://claude.feedland.org` → `wss://claude.feedland.org/`. */
function socketUrl(server) {
  const url = new URL(server);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  return url.href;
}

const SOCKET_RETRY_MIN_MS = 1000;
const SOCKET_RETRY_MAX_MS = 60000;

/**
 * `<blog-roll opmlurl="…" server="…">`
 *
 * ── The socket ────────────────────────────────────────────────────────────────
 *
 * FeedLand pushes a message every time it notices a feed has changed, and this
 * element now listens: the times in the list stay honest on a page left open, and a
 * feed that publishes while someone is reading moves without a reload. It is
 * strictly an enhancement — the list is fully rendered from the two HTTP calls
 * before the socket is even opened, so a blocked, refused or dead socket costs
 * nothing but the live updates.
 *
 * Three deliberate differences from blogroll.js, which does the same job:
 *
 *   * **It reconnects with a backoff, not a 1-second poll.** His client runs
 *     `setInterval(checkConnection, 1000)` for the life of the page. If the server
 *     is down that is 3,600 connection attempts an hour, from every open tab. This
 *     doubles 1s → 60s and stays there.
 *   * **It closes on disconnect.** A custom element that opens a socket and never
 *     closes it leaks the connection and its retry timer every time the element is
 *     removed. `disconnectedCallback` is the whole reason this is on the class
 *     rather than in a module-level function.
 *   * **It will not reorder the list while a feed is open.** Re-sorting is right —
 *     the list claims to be newest-first — but doing it under someone who is mid-way
 *     through reading an expanded feed pulls the text they are looking at somewhere
 *     else. The time updates in place immediately either way; only the row order
 *     waits until nothing is open.
 */
class BlogRoll extends HTMLElement {
  #socket = null;
  #retryTimer = null;
  #retryDelay = SOCKET_RETRY_MIN_MS;
  #feeds = [];
  #renderPending = false;

  constructor() {
    super();
    this.opmlurl = '';
    this.server = DEFAULT_SERVER;
  }

  static get observedAttributes() {
    return ['opmlurl', 'server'];
  }

  attributeChangedCallback(property, oldValue, newValue) {
    if (oldValue === newValue) return;

    if (property === 'opmlurl') this.opmlurl = newValue;
    // An empty or removed attribute means "the default", not "no server".
    if (property === 'server') this.server = newValue || DEFAULT_SERVER;

    this.#scheduleRender();
  }

  connectedCallback() {
    this.#scheduleRender();
  }

  /**
   * Coalesce the renders a single page load asks for.
   *
   * `attributeChangedCallback` fires once per attribute and `connectedCallback`
   * once more, so `<blog-roll opmlurl="…" server="…">` used to mean two or three
   * full renders — each one a real request to FeedLand for the same list, and the
   * later answer racing the earlier one into the same element. A microtask is
   * enough: every callback the parser is going to make for this element has already
   * happened by the time it runs.
   */
  #scheduleRender() {
    if (this.#renderPending) return;

    this.#renderPending = true;
    queueMicrotask(() => {
      this.#renderPending = false;
      this.render();
    });
  }

  disconnectedCallback() {
    this.#closeSocket();
  }

  async render() {
    const feedlist = await getFeedListFromOpml(this.opmlurl, this.server);
    const details = await Promise.all(
      feedlist.map((feed) => detailsElement(feed, this.server)),
    );

    this.innerHTML = '';
    details.forEach((d) => this.appendChild(d));

    // Kept so a socket update can re-sort without asking FeedLand again.
    this.#feeds = feedlist;

    // After the list is on the page, never before: the socket is the enhancement,
    // and an empty list means there is nothing for an update to update.
    if (feedlist.length > 0) this.#openSocket();
  }

  #openSocket() {
    if (this.#socket !== null || !this.isConnected) return;

    let socket;
    try {
      socket = new WebSocket(socketUrl(this.server));
    } catch (error) {
      // A malformed `server`, or a policy that refuses the connection outright.
      console.error('Blog roll: cannot open the FeedLand socket:', error);
      return;
    }

    this.#socket = socket;

    socket.addEventListener('open', () => {
      // What blogroll.js sends on connect. FeedLand does not appear to require it,
      // but this is a third party's protocol and matching their client is cheaper
      // than being the one connection that behaves differently.
      socket.send('hello world');
      this.#retryDelay = SOCKET_RETRY_MIN_MS;
    });

    socket.addEventListener('message', (event) => {
      const message = parseSocketMessage(event.data);
      if (message?.command === 'updatedFeed') this.#applyUpdate(message.payload);
    });

    socket.addEventListener('close', () => {
      this.#socket = null;
      this.#scheduleReconnect();
    });

    // Without this an error is an unhandled event; the close that follows it is
    // what actually schedules the retry.
    socket.addEventListener('error', () => {});
  }

  #scheduleReconnect() {
    if (!this.isConnected || this.#retryTimer !== null) return;

    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#openSocket();
    }, this.#retryDelay);

    this.#retryDelay = Math.min(this.#retryDelay * 2, SOCKET_RETRY_MAX_MS);
  }

  #closeSocket() {
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }

    if (this.#socket !== null) {
      const socket = this.#socket;
      // Cleared first: `close()` fires the close handler, which would otherwise
      // schedule a reconnect for an element that is going away.
      this.#socket = null;
      socket.close();
    }
  }

  /**
   * One `updatedFeed` message.
   *
   * Feeds we are not showing are ignored — this socket carries every feed the
   * server watches, not just ours — and so is an update with a date we could not
   * render, which is the same guard the list itself passes through.
   */
  #applyUpdate(payload) {
    const feedUrl = payload?.feedUrl;
    if (feedUrl === undefined) return;
    if (!isRenderableDate(payload?.whenUpdated)) return;

    const feed = this.#feeds.find((candidate) => candidate.feedUrl === feedUrl);
    if (feed === undefined) return;

    feed.whenUpdated = payload.whenUpdated;

    const details = this.querySelector(`details[data-feedurl="${CSS.escape(feedUrl)}"]`);
    const time = details?.querySelector('summary time');
    if (time) {
      time.setAttribute('datetime', feed.whenUpdated);
      time.textContent = timeAgo(feed.whenUpdated);
    }

    // Only when nobody is mid-read. See the class comment.
    if (this.querySelector('details[open]') === null) this.#reorder();
  }

  /** Put the rows back in newest-first order, moving nodes rather than rebuilding. */
  #reorder() {
    this.#feeds.sort(compareDates.bind(null, 'whenUpdated'));

    for (const feed of this.#feeds) {
      const details = this.querySelector(
        `details[data-feedurl="${CSS.escape(feed.feedUrl)}"]`,
      );
      // `appendChild` on a node already in the tree MOVES it, so appending each row
      // in order sorts the list without discarding the elements — which is what
      // keeps any already-fetched items and the `open` state alive.
      if (details) this.appendChild(details);
    }
  }
}

customElements.define('blog-roll', BlogRoll);
