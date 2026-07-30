#!/usr/bin/env node
/**
 * `node bin/rsscloud.js` — ping our rssCloud server by hand (plan §6.4).
 *
 * The server does this once per boot, which covers every deploy. This is for the times
 * it did not happen: a publish that went out while the cloud server was down, a
 * restart that raced its own DNS, or simply wanting to see the answer.
 *
 *   docker compose exec iheartrss node bin/rsscloud.js
 *
 * `RSSCLOUD_ENABLED` gates the *timer*, not an explicit request — an operator running
 * this has already decided. The SITE_URL reachability rule still applies: asking a
 * public server to fetch `http://localhost:3000/feed.xml` is not a thing we do by hand
 * either.
 */

import { loadConfig } from '../src/config.js';
import { createRsscloudPing } from '../src/jobs/rsscloud.js';

const config = loadConfig(process.env);

const job = createRsscloudPing({
  // Forced on, and forced to the production branch: "I typed this" is the operator
  // asserting that SITE_URL is the real, deployed origin.
  config: { ...config, rsscloudEnabled: true, production: true },
  log: (msg, fields) => console.log(JSON.stringify({ msg, ...fields })),
});

const result = await job.runOnce();

// A non-zero exit so `&&` chains and cron mail behave: an unnoticed failed ping is the
// whole failure mode here.
if (!result.pinged) process.exit(1);
