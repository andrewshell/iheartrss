#!/usr/bin/env node
/**
 * `node bin/rsscloud.js [feed|opml|all]` — ping our rssCloud server by hand (§6.4).
 *
 * The server does this on its own: `/feed.xml` once per boot, which covers every
 * deploy, and `/subscriptions.opml` whenever a feed joins the directory. This is for
 * the times it did not happen — a publish that went out while the cloud server was
 * down, a restart that raced its own DNS, a member added by a direct INSERT, or simply
 * wanting to see the answer.
 *
 *   docker compose exec iheartrss node bin/rsscloud.js
 *   docker compose exec iheartrss node bin/rsscloud.js opml
 *
 * With no argument it pings both, because "tell the cloud server everything changed" is
 * what an operator typing this by hand almost always means.
 *
 * `RSSCLOUD_ENABLED` gates the *timers*, not an explicit request — an operator running
 * this has already decided. The SITE_URL reachability rule still applies: asking a
 * public server to fetch `http://localhost:3000/feed.xml` is not a thing we do by hand
 * either.
 */

import { loadConfig } from '../src/config.js';
import { createRsscloudPing } from '../src/jobs/rsscloud.js';

const TARGETS = { feed: ['feed'], opml: ['opml'], all: ['feed', 'opml'] };

const which = process.argv[2] ?? 'all';
const targets = TARGETS[which];

if (targets === undefined) {
  console.error(`usage: node bin/rsscloud.js [${Object.keys(TARGETS).join('|')}]`);
  process.exit(2);
}

const config = loadConfig(process.env);

const job = createRsscloudPing({
  // Forced on, and forced to the production branch: "I typed this" is the operator
  // asserting that SITE_URL is the real, deployed origin.
  config: { ...config, rsscloudEnabled: true, production: true },
  log: (msg, fields) => console.log(JSON.stringify({ msg, ...fields })),
});

const results = [];
for (const target of targets) {
  results.push(await (target === 'feed' ? job.runOnce() : job.pingOpml()));
}

// A non-zero exit so `&&` chains and cron mail behave: an unnoticed failed ping is the
// whole failure mode here. Any one failure fails the run — a partial success is still
// a document whose subscribers were not notified.
if (!results.every((result) => result.pinged)) process.exit(1);
