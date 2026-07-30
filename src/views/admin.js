/**
 * The admin UI (plan §6, §12 phase 8b).
 *
 * **Never linked from a public page**, and `robots.txt` disallows `/admin` — but the
 * pages themselves also carry `noindex` from the route, because a `Disallow` is a
 * request and a link someone pastes into a chat window is a crawl.
 *
 * It reuses the public `layout()` deliberately: the stylesheet, the header and the
 * dark-mode swap are already there, and an admin page with its own CSS is one more
 * thing to keep working. Forms are plain HTML POSTs — there is no JS on this site.
 */

import { html } from 'hono/html';

import { layout } from './layout.js';

export function adminLoginPage({ config, error = null, retryAfterSeconds = null }) {
  const body = html`
<section class="panel">
  <h1>Admin</h1>
  ${error === 'unauthorized'
    ? html`<p class="panel__error">That token was not accepted.</p>`
    : ''}
  ${error === 'throttled'
    ? html`<p class="panel__error">
        Too many attempts. Try again in about ${Math.ceil((retryAfterSeconds ?? 60) / 60)}
        minute(s).
      </p>`
    : ''}
  <form class="submit-form" method="post" action="/admin/login">
    <label for="token">Admin token</label>
    <input id="token" name="token" type="password" autocomplete="off" required>
    <button type="submit">Sign in</button>
  </form>
</section>
`;

  return layout({ title: 'Admin', body, config });
}

/**
 * The dashboard. Every mutating control is a form carrying `csrf`, which is derived
 * from the session id and therefore rotates with it (§6).
 */
export function adminDashboard({
  config,
  csrf,
  recent = [],
  attention = [],
  submissions = [],
  histogram = [],
  reports = [],
  bans = [],
  domainLimits = [],
  backlog = { oldest_last_checked_at: null, overdue_count: 0 },
  memberCount = 0,
}) {
  const body = html`
<section class="panel">
  <h1>Admin</h1>
  <p class="lede">
    ${memberCount} listed member(s).
    <span data-overdue-count="${backlog.overdue_count}">
      ${backlog.overdue_count} overdue for revalidation</span>;
    oldest check ${backlog.oldest_last_checked_at ?? 'never'}.
  </p>
  <form class="admin-inline" method="post" action="/admin/logout">
    ${csrfField(csrf)}
    <button type="submit">Log out</button>
  </form>
</section>

${histogramSection(histogram)}
${reportsSection(reports, csrf)}
${sitesSection('Failing and blocked', attention, csrf)}
${sitesSection('Recent listings', recent, csrf)}
${submissionsSection(submissions)}
${bansSection(bans, csrf)}
${domainLimitsSection(domainLimits, csrf)}
`;

  return layout({ title: 'Admin', body, config });
}

/**
 * §10: the rejection-reason histogram is "the fastest way to learn which design
 * decision is costing members" — five `feed_not_rss2` rejections a week is an
 * argument about the RSS-2.0-only decision, and it is invisible in a list of rows.
 *
 * The `data-reason`/`data-count` attributes are the machine-readable form of each
 * bar, which is also what the tests assert against — the text next to them is free to
 * be rephrased.
 */
function histogramSection(rows) {
  const total = rows.reduce((sum, row) => sum + row.n, 0);

  return html`
<section class="panel">
  <h2>Why submissions are failing</h2>
  ${rows.length === 0
    ? html`<p>No rejections recorded.</p>`
    : html`<ul class="admin-histogram">
        ${rows.map(
          (row) => html`<li data-reason="${row.reason}" data-count="${row.n}">
            <code>${row.reason}</code>
            <span class="admin-count">${row.n}</span>
            <span class="admin-meta">${Math.round((row.n / total) * 100)}%</span>
          </li>`,
        )}
      </ul>`}
</section>
`;
}

function reportsSection(rows, csrf) {
  return html`
<section class="panel">
  <h2>Reports</h2>
  ${rows.length === 0
    ? html`<p>No reports.</p>`
    : html`<ul class="admin-list">
        ${rows.map(
          (row) => html`<li>
            <a href="${row.url}">${row.url}</a>
            <span class="admin-meta">
              #${row.id} ${row.created_at}
              ${row.site_id === null ? 'not listed' : html`site #${row.site_id}`}
              ${row.handled_at === null ? 'open' : html`handled ${row.handled_at}`}
            </span>
            <p class="admin-report-reason">${row.reason}</p>
            ${row.contact ? html`<p class="admin-meta">contact: ${row.contact}</p>` : ''}
            ${row.handled_at === null
              ? html`<form class="admin-inline" method="post"
                            action="/admin/reports/${row.id}/handle">
                  ${csrfField(csrf)}
                  <input name="reason" type="text" placeholder="what was done"
                         aria-label="what was done">
                  <button type="submit">Mark handled</button>
                </form>`
              : ''}
          </li>`,
        )}
      </ul>`}
</section>
`;
}

function submissionsSection(rows) {
  return html`
<section class="panel">
  <h2>Recent submissions</h2>
  ${rows.length === 0
    ? html`<p>None yet.</p>`
    : html`<ul class="admin-list">
        ${rows.map(
          (row) => html`<li>
            <code>${row.submitted_url}</code>
            <span class="admin-meta">${row.result}
              ${row.reason ? html`<code>${row.reason}</code>` : ''} ${row.created_at}</span>
          </li>`,
        )}
      </ul>`}
</section>
`;
}

/**
 * The ban form carries all three shapes §4 defines, because the two that are easy to
 * forget — `host_suffix` for a wildcard-DNS flood and `path_prefix` for one account
 * on a shared host — are exactly the ones an operator needs under pressure.
 */
function bansSection(rows, csrf) {
  return html`
<section class="panel">
  <h2>Bans</h2>
  <form class="submit-form" method="post" action="/admin/ban">
    ${csrfField(csrf)}
    <label for="ban-host">Host (exact)</label>
    <input id="ban-host" name="host" type="text" placeholder="spam.example">
    <label for="ban-suffix">Host suffix (wildcard DNS)</label>
    <input id="ban-suffix" name="host_suffix" type="text" placeholder=".attacker.example">
    <label for="ban-path">Path prefix (one account on a shared host)</label>
    <input id="ban-path" name="path_prefix" type="text" placeholder="/@spammer">
    <label for="ban-reason">Reason</label>
    <input id="ban-reason" name="reason" type="text">
    <button type="submit">Ban</button>
  </form>
  ${rows.length === 0
    ? html`<p>No bans.</p>`
    : html`<ul class="admin-list">
        ${rows.map(
          (row) => html`<li>
            <code>${row.host || row.host_suffix}${row.path_prefix}</code>
            <span class="admin-meta">${row.reason ?? ''} ${row.created_at}</span>
          </li>`,
        )}
      </ul>`}
</section>
`;
}

function domainLimitsSection(rows, csrf) {
  return html`
<section class="panel">
  <h2>Per-domain listing caps</h2>
  <p>
    <code>-1</code> is unlimited; an empty limit deletes the override and returns the
    domain to the configured default.
  </p>
  <form class="submit-form" method="post" action="/admin/domain-limits">
    ${csrfField(csrf)}
    <label for="limit-domain">Registrable domain</label>
    <input id="limit-domain" name="domain" type="text" placeholder="substack.com" required>
    <label for="limit-max">Max listings</label>
    <input id="limit-max" name="max_listings" type="number" min="-1">
    <label for="limit-note">Note</label>
    <input id="limit-note" name="note" type="text">
    <button type="submit">Save</button>
  </form>
  ${rows.length === 0
    ? html`<p>No overrides.</p>`
    : html`<ul class="admin-list">
        ${rows.map(
          (row) => html`<li>
            <code>${row.domain}</code>
            <span class="admin-count">${row.max_listings}</span>
            <span class="admin-meta">${row.note ?? ''}</span>
          </li>`,
        )}
      </ul>`}
</section>
`;
}

/**
 * A site list with the one control that applies to it. `hidden` rows get an unhide
 * button instead of a hide one — the two are not symmetrical (an unhide re-verifies).
 */
function sitesSection(heading, rows, csrf) {
  return html`
<section class="panel">
  <h2>${heading}</h2>
  ${rows.length === 0
    ? html`<p>Nothing here.</p>`
    : html`<ul class="admin-list">
        ${rows.map(
          (row) => html`<li>
            <a href="${row.url}">${row.title}</a>
            <span class="admin-meta">#${row.id} ${row.status}
              ${row.last_error ? html`(${row.last_error})` : ''}</span>
            <form class="admin-inline" method="post"
                  action="/admin/sites/${row.id}/${row.status === 'hidden' ? 'unhide' : 'hide'}">
              ${csrfField(csrf)}
              <input name="reason" type="text" placeholder="reason" aria-label="reason">
              <button type="submit">${row.status === 'hidden' ? 'Unhide' : 'Hide'}</button>
            </form>
          </li>`,
        )}
      </ul>`}
</section>
`;
}

export function csrfField(csrf) {
  // The attribute order here is load-bearing for nothing but readability; the token
  // itself is escaped by hono/html like any other interpolation.
  return html`<input type="hidden" name="csrf" value="${csrf}">`;
}
