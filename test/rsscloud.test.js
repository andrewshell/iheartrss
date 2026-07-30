import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';
import { createRsscloudPing } from '../src/jobs/rsscloud.js';

// Plan §6.4: our own feed advertises an rssCloud server, so it also has to tell that
// server when it changes. The ping is one form-encoded POST on boot — see the module
// comment for why every restart is the right trigger and not abuse.
//
// Every test here injects `fetchFn`. Nothing in this file may touch the network:
// rpc.rsscloud.io is somebody's live server.

/** A production-shaped config, which is the only shape that pings at all. */
function config(env = {}) {
  return loadConfig({ NODE_ENV: 'production', ...env });
}

function recorder() {
  const calls = [];
  const log = (msg, fields) => calls.push({ msg, ...fields });
  return { calls, log, of: (msg) => calls.filter((c) => c.msg === msg) };
}

function jsonOk() {
  return new Response(JSON.stringify({ success: true, msg: 'Thanks for the ping.' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('the ping POSTs url=<our feed> form-encoded to the configured endpoint', async () => {
  const sent = [];
  const logs = recorder();
  const job = createRsscloudPing({
    config: config(),
    log: logs.log,
    fetchFn: async (url, init) => {
      sent.push({ url, init });
      return jsonOk();
    },
  });

  const result = await job.runOnce();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://rpc.rsscloud.io/ping');
  assert.equal(sent[0].init.method, 'POST');
  // The one parameter the rssCloud REST API takes, percent-encoded as a form body —
  // not JSON, not a query string.
  assert.equal(sent[0].init.body, 'url=https%3A%2F%2Fiheartrss.com%2Ffeed.xml');
  assert.equal(sent[0].init.headers['content-type'], 'application/x-www-form-urlencoded');
  // Without this the server answers `<result success="true" .../>` XML.
  assert.equal(sent[0].init.headers.accept, 'application/json');

  assert.equal(result.pinged, true);
  assert.equal(logs.of('rsscloud.pinged').length, 1);
});

test('a non-2xx answer is a logged failure, not a silent success', async () => {
  const logs = recorder();
  const job = createRsscloudPing({
    config: config(),
    log: logs.log,
    fetchFn: async () => new Response('no', { status: 500 }),
  });

  const result = await job.runOnce();

  assert.equal(result.pinged, false);
  assert.equal(logs.of('rsscloud.pinged').length, 0);
  const [failure] = logs.of('rsscloud.ping_failed');
  assert.equal(failure.status, 500);
});

test('a network error and a timeout are logged and swallowed — runOnce never rejects', async () => {
  // An unhandled rejection from a timer terminates the process in Node 24, so a
  // stranger's DNS being down must not be able to take the site with it.
  const dead = recorder();
  const refused = await createRsscloudPing({
    config: config(),
    log: dead.log,
    fetchFn: async () => {
      throw new TypeError('fetch failed');
    },
  }).runOnce();

  assert.equal(refused.pinged, false);
  assert.match(dead.of('rsscloud.ping_failed')[0].error, /fetch failed/);

  const slow = recorder();
  const timedOut = await createRsscloudPing({
    config: config(),
    log: slow.log,
    // What `AbortSignal.timeout` actually produces once it fires.
    fetchFn: async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    },
  }).runOnce();

  assert.equal(timedOut.pinged, false);
  assert.equal(slow.of('rsscloud.ping_failed')[0].reason, 'timeout');
});

test('a SITE_URL that is not publicly reachable is never handed to a public server', async () => {
  // An operator running with SITE_URL=http://localhost:3000 would otherwise be asking
  // rpc.rsscloud.io to fetch a private address — pointless at best, and a request to
  // somebody else's server to probe a network it cannot see at worst.
  for (const siteUrl of [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://192.168.1.10',
    'http://10.0.0.5:8080',
    'http://[::1]:3000',
    'http://myhost',
  ]) {
    let fetched = 0;
    const logs = recorder();
    const result = await createRsscloudPing({
      config: config({ SITE_URL: siteUrl }),
      log: logs.log,
      fetchFn: async () => {
        fetched += 1;
        return jsonOk();
      },
    }).runOnce();

    assert.equal(fetched, 0, `${siteUrl} must not be pinged`);
    assert.equal(result.skipped, 'site_url_not_public', siteUrl);
    assert.equal(logs.of('rsscloud.skipped').length, 1, siteUrl);
  }
});

test('outside production nothing is pinged, even with the default public SITE_URL', async () => {
  // `pnpm dev` runs `node --watch`, which restarts on every keystroke-and-save. With
  // SITE_URL defaulting to https://iheartrss.com that would be a stream of pings at a
  // live third-party server from a machine that has not published anything.
  let fetched = 0;
  const logs = recorder();
  const result = await createRsscloudPing({
    config: loadConfig({ RSSCLOUD_ENABLED: 'true' }),
    log: logs.log,
    fetchFn: async () => {
      fetched += 1;
      return jsonOk();
    },
  }).runOnce();

  assert.equal(fetched, 0);
  assert.equal(result.skipped, 'not_production');
  assert.equal(logs.of('rsscloud.skipped')[0].reason, 'not_production');
});

/** A `setTimeout` stand-in that records the delay and runs the callback on demand. */
function fakeTimer() {
  const scheduled = [];
  return {
    scheduled,
    timers: {
      setTimeout: (fn, ms) => {
        scheduled.push({ fn, ms });
        return { unref: () => (scheduled[scheduled.length - 1].unrefd = true) };
      },
      clearTimeout: (handle) => {
        handle.cleared = true;
      },
    },
  };
}

test('start() schedules one ping off the boot path, unref’d, and stop() cancels it', async () => {
  let fetched = 0;
  const clock = fakeTimer();
  const job = createRsscloudPing({
    config: config(),
    fetchFn: async () => {
      fetched += 1;
      return jsonOk();
    },
  });

  assert.equal(job.start(clock.timers), true);
  // Not on the boot path: scheduled, not sent — `serve()` must never wait on a
  // third-party host.
  assert.equal(clock.scheduled.length, 1);
  assert.equal(fetched, 0);
  assert.equal(clock.scheduled[0].unrefd, true);

  await clock.scheduled[0].fn();
  assert.equal(fetched, 1);

  // One ping per boot, and no timer left behind for shutdown to trip over.
  job.stop();
  assert.equal(clock.scheduled.length, 1);
});

test('RSSCLOUD_ENABLED=false schedules nothing and sends nothing', () => {
  const clock = fakeTimer();
  const logs = recorder();
  const job = createRsscloudPing({
    config: config({ RSSCLOUD_ENABLED: 'false' }),
    log: logs.log,
    fetchFn: async () => assert.fail('a disabled ping must not fetch'),
  });

  assert.equal(job.start(clock.timers), false);
  assert.equal(clock.scheduled.length, 0);
  assert.equal(logs.of('rsscloud.disabled').length, 1);
});
