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

    // Return the parsed data, minus the feeds there is nothing to read behind yet.
    return (data?.feedlist ?? [])
      .filter(hasBeenCrawled)
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

    // Return the parsed data
    return data.sort(compareDates.bind(null, 'whenUpdated'));
  } catch (error) {
    console.error('Error fetching feed list from OPML:', error);
    return [];
  }
}

function listItemElement(item) {
  const link = document.createElement('a');
  link.setAttribute('href', item.link);
  link.textContent = stripAndTruncate(item.title || item.description, 100);

  const time = document.createElement('time');
  time.setAttribute('datetime', item.whenUpdated);
  time.textContent = timeAgo(item.whenUpdated);

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
