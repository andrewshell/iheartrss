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

async function getFeedListFromOpml(url) {
  try {
    // Fetch the data from the API endpoint
    const response = await fetch(
      `https://feedland.com/getfeedlistfromopml?url=${encodeURIComponent(url)}`,
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

async function getFeedItems(url, maxItems) {
  try {
    // Fetch the data from the API endpoint
    const response = await fetch(
      `https://feedland.com/getfeeditems?url=${encodeURIComponent(url)}&maxItems=${encodeURIComponent(maxItems)}`,
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
 */
function listItemElement(item) {
  const link = document.createElement('a');
  link.setAttribute('href', item.link);
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

async function detailsElement(feed) {
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

  details.addEventListener('toggle', (event) => {
    if (event.newState === 'open') {
      getFeedItems(feed.feedUrl, 5).then((items) => {
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

class BlogRoll extends HTMLElement {
  constructor() {
    super();
    this.opmlurl = '';
  }

  static get observedAttributes() {
    return ['opmlurl'];
  }

  attributeChangedCallback(property, oldValue, newValue) {
    if (oldValue === newValue) return;

    if (property === 'opmlurl') {
      this.opmlurl = newValue;
      this.render();
    }
  }

  connectedCallback() {
    this.render();
  }

  async render() {
    const feedlist = await getFeedListFromOpml(this.opmlurl);
    const details = await Promise.all(feedlist.map(detailsElement));

    this.innerHTML = '';
    details.forEach((d) => this.appendChild(d));
  }
}

customElements.define('blog-roll', BlogRoll);
