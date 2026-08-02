#!/usr/bin/env node
/**
 * `pnpm verify <url>` — the phase-4 deliverable (§12.4): run the whole §5 pipeline
 * against a real site and print a full verification report.
 *
 * It wires the real `dns.lookup` and the real classifier, so this is the same code path
 * `/submit` will take in phase 5 — minus Step 7, which does not exist yet. It writes
 * nothing anywhere.
 */

import { lookup } from 'node:dns';

import { loadConfig } from '../src/config.js';
import { createFetcher } from '../src/verify/fetch.js';
import { createVerifier } from '../src/verify/index.js';
import { createRenderer } from '../src/verify/render.js';

const [, , target, ...rest] = process.argv;

if (target === undefined || target === '' || rest.length > 0) {
  process.stderr.write('usage: pnpm verify <url>\n');
  process.exit(2);
}

const config = loadConfig(process.env);
const safeFetch = createFetcher({ lookup, config });
// §5 Step 5's rendering fallback, wired here for the same reason the real `dns.lookup`
// is: this CLI is only useful if it is the code path `/submit` takes. Left out, it
// reports `no_linkback` for every JS-rendered site while the running app passes them —
// the one discrepancy that makes the tool actively misleading.
// Logs to stderr, not the swallowed no-op the app uses: "why did this say no
// link-back" is the question this CLI exists to answer, and a 401 from the rendering
// provider is the answer often enough to be worth the two lines.
const renderPage = createRenderer({
  config,
  log: (msg, fields) => process.stderr.write(`${JSON.stringify({ msg, ...fields })}\n`),
});
const verifySite = createVerifier({ safeFetch, config, renderPage });

const started = Date.now();
const result = await verifySite(target);
const elapsed = Date.now() - started;

const lines = [];
const say = (label, value) => {
  if (value === undefined || value === null || value === '') return;
  lines.push(`${label.padEnd(22)} ${value}`);
};

lines.push('');
lines.push(result.ok ? '  PASS' : '  FAIL');
lines.push('');
say('submitted', target);

if (result.ok) {
  say('canonical url', result.url);
  say('feed url', result.feedUrl);
  say('title', result.title);
  say('description', result.description);
  say('link-back found', result.linkBack);
  // Named on a pass too, not just a failure: a member silently depending on the
  // rendering quota is exactly the thing worth knowing before the quota runs out.
  say('link-back source', result.linkBackRendered ? 'rendered page' : 'served HTML');

  const f = result.features ?? {};
  lines.push('');
  say('has_source_ns', String(f.has_source_ns));
  say('source_ns_prefix', f.source_ns_prefix);
  say('has_rsscloud', String(f.has_rsscloud));
  say('rsscloud_style', f.rsscloud_style);
  if (f.cloud !== null && f.cloud !== undefined) {
    say('cloud', JSON.stringify(f.cloud));
  }
  say('cloud_url', f.cloud_url);
} else {
  say('reason', result.reason);
  say('status', result.status === undefined ? undefined : String(result.status));
  // On `render_unavailable` this is the actual cause; on `no_linkback` it answers the
  // first question anyone asks, which is whether the fallback ran at all.
  say('render failure', result.renderReason);
  if (result.reason === 'no_linkback') {
    say('rendering', result.rendered ? 'ran, still no link' : 'not configured');
  }
  say('url', result.url);
  say('feed url', result.feedUrl);
  say('channel link', result.channelLink);
  say('other-format feed', result.otherFormatUrl);
  say('underlying reason', result.feedReason);
  say('fetched', result.fetchedUrl);
}

lines.push('');
say('elapsed', `${elapsed}ms`);
lines.push('');

process.stdout.write(`${lines.join('\n')}\n`);
process.exit(result.ok ? 0 : 1);
