import test from 'node:test';
import assert from 'node:assert/strict';

import { classify } from '../src/jobs/revalidate.js';
import { createVerifier } from '../src/verify/index.js';
import { createRenderer } from '../src/verify/render.js';
import { BADGE, CONFIG, FEED_TYPE, html, rss, withSites } from './helpers/sites.js';

// §5 Step 5's JS-rendering fallback. Nothing here reaches a network: `createRenderer`
// takes an injected `fetchImpl`, and the pages themselves come from the same fixture
// server every other verify test uses.

const RENDER_CONFIG = Object.freeze({
  ...CONFIG,
  renderEnabled: true,
  renderApiUrl: 'https://render.example/content',
  renderApiToken: 'test-token',
  renderTimeoutMs: 2000,
});

/** A `fetchImpl` that answers every render with `body`, recording what it was asked. */
function stubRenderApi(body, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  };
  return { fetchImpl, calls };
}

/**
 * The shell rss.chat actually serves: a real feed link in `<head>`, and a body that
 * only JavaScript fills in. `badge: false` is the entire point of the fixture — with
 * the default this page passes Step 5 on its own markup and tests nothing.
 */
function shell(feedHref) {
  return html({
    feedHref,
    badge: false,
    body: '<div id="app"></div><script src="/code.js"></script>',
  });
}

test('a JS-rendered page passes once the fallback finds the link', async () => {
  const { fetchImpl, calls } = stubRenderApi(
    JSON.stringify({ success: true, result: `<html><body>${BADGE}</body></html>` }),
  );

  await withSites(
    (url) => ({
      'rendered.example': {
        '/': { body: shell('/feed.xml') },
        '/feed.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'Rendered', channelLink: url('rendered.example', '/') }),
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({
        safeFetch,
        config: RENDER_CONFIG,
        renderPage: createRenderer({ config: RENDER_CONFIG, fetchImpl }),
      });

      const result = await verifySite(url('rendered.example', '/'));

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.linkBackRendered, true);
      // The renderer was asked for the canonical page, exactly once.
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.url, url('rendered.example', '/'));
    },
  );
});

test('a page whose served HTML already links back never spends a render', async () => {
  // The cost rule: the fallback tracks failures, not membership. If this regresses,
  // every weekly revalidation of every healthy member starts billing browser time.
  const { fetchImpl, calls } = stubRenderApi('unused');

  await withSites(
    (url) => ({
      'plain.example': {
        '/': { body: html({ feedHref: '/feed.xml' }) },
        '/feed.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'Plain', channelLink: url('plain.example', '/') }),
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({
        safeFetch,
        config: RENDER_CONFIG,
        renderPage: createRenderer({ config: RENDER_CONFIG, fetchImpl }),
      });

      const result = await verifySite(url('plain.example', '/'));

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.linkBackRendered, false);
      assert.deepEqual(calls, []);
    },
  );
});

test('a render that succeeds and still finds nothing is `no_linkback`, not transient', async () => {
  // Rendering must not become a way to never conclude anything. Once we have actually
  // seen the finished page, an absent badge is an absent badge.
  const { fetchImpl } = stubRenderApi(
    JSON.stringify({
      success: true,
      result: '<html><body><p>no badge here</p></body></html>',
    }),
  );

  await withSites(
    (url) => ({
      'bare.example': {
        '/': { body: shell('/feed.xml') },
        '/feed.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'Bare', channelLink: url('bare.example', '/') }),
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({
        safeFetch,
        config: RENDER_CONFIG,
        renderPage: createRenderer({ config: RENDER_CONFIG, fetchImpl }),
      });

      const result = await verifySite(url('bare.example', '/'));

      assert.equal(result.ok, false);
      assert.equal(result.reason, 'no_linkback');
      assert.equal(result.rendered, true);
    },
  );
});

test('a failed render is `render_unavailable`, never `no_linkback`', async () => {
  // The whole point of the feature's failure mode: a rendering outage must not be
  // evidence that a member removed their badge. See `classify` in jobs/revalidate.js.
  const { fetchImpl } = stubRenderApi('{"success":false,"errors":[{"code":1000}]}', {
    status: 429,
  });

  await withSites(
    (url) => ({
      'outage.example': {
        '/': { body: shell('/feed.xml') },
        '/feed.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'Outage', channelLink: url('outage.example', '/') }),
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({
        safeFetch,
        config: RENDER_CONFIG,
        renderPage: createRenderer({ config: RENDER_CONFIG, fetchImpl }),
      });

      const result = await verifySite(url('outage.example', '/'));

      assert.equal(result.ok, false);
      assert.equal(result.reason, 'render_unavailable');
      assert.equal(result.renderReason, 'render_http_error');
    },
  );
});

test('a renderer that throws is a transient result, not an exception', async () => {
  // `verifySite` never throws for an expected failure, and one site must not be able
  // to cancel the other 19 in a revalidation batch.
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };

  await withSites(
    (url) => ({
      'down.example': {
        '/': { body: shell('/feed.xml') },
        '/feed.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'Down', channelLink: url('down.example', '/') }),
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({
        safeFetch,
        config: RENDER_CONFIG,
        renderPage: createRenderer({ config: RENDER_CONFIG, fetchImpl }),
      });

      const result = await verifySite(url('down.example', '/'));

      assert.equal(result.ok, false);
      assert.equal(result.reason, 'render_unavailable');
      assert.equal(result.renderReason, 'render_request_failed');
    },
  );
});

test('an unconfigured renderer is null, and the pipeline is unchanged', async () => {
  assert.equal(createRenderer({ config: CONFIG }), null);
  assert.equal(createRenderer({ config: { ...CONFIG, renderEnabled: false } }), null);

  await withSites(
    (url) => ({
      'noconfig.example': {
        '/': { body: shell('/feed.xml') },
        '/feed.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'No config', channelLink: url('noconfig.example', '/') }),
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('noconfig.example', '/'));

      assert.equal(result.reason, 'no_linkback');
      assert.equal(result.rendered, false);
    },
  );
});

test('the renderer accepts a bare-HTML response as well as a JSON envelope', async () => {
  // `renderApiUrl` is an operator knob, so the envelope is not guaranteed to be
  // Cloudflare's — and Cloudflare's own /content docs do not write the shape down.
  const { fetchImpl } = stubRenderApi(`<html><body>${BADGE}</body></html>`);
  const renderPage = createRenderer({ config: RENDER_CONFIG, fetchImpl });

  const rendered = await renderPage('https://example.com/');

  assert.equal(rendered.ok, true);
  assert.match(rendered.html, /iheartrss\.com/);
});

test('the renderer refuses a target the SSRF classifier would refuse', async () => {
  // The URL in the request body is member-controlled. Having already fetched it once
  // is not the same claim as "safe to ask a third party to fetch now".
  const { fetchImpl, calls } = stubRenderApi('unused');
  const renderPage = createRenderer({ config: RENDER_CONFIG, fetchImpl });

  for (const target of [
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
  ]) {
    const rendered = await renderPage(target);
    assert.equal(rendered.ok, false, target);
    assert.equal(rendered.reason, 'render_target_blocked', target);
  }

  assert.deepEqual(calls, [], 'no blocked target may reach the rendering API');
});

test('an over-large rendered document is refused rather than truncated', async () => {
  // Same rule as `fetch.js`: a truncated page parses fine and merely lacks the
  // link-back, which §8 would read as an opt-out.
  const { fetchImpl } = stubRenderApi('x'.repeat(2048));
  const renderPage = createRenderer({
    config: { ...RENDER_CONFIG, maxResponseBytes: 1024 },
    fetchImpl,
  });

  const rendered = await renderPage('https://example.com/');

  assert.equal(rendered.ok, false);
  assert.equal(rendered.reason, 'render_too_large');
});

test('revalidation classifies a rendering outage as transient, never as an opt-out', () => {
  // The consequence this guards: three transient ticks are a strike count, but three
  // OPT-OUT ticks are removal. If a Cloudflare outage were classified as an opt-out it
  // would start the removal clock for every JS-rendered member simultaneously, for a
  // reason none of them caused and none of them can see.
  assert.equal(classify({ ok: false, reason: 'render_unavailable' }), 'transient');
  assert.equal(classify({ ok: false, reason: 'no_linkback' }), 'optout');
  assert.equal(classify({ ok: true }), 'pass');
});

test('an exhausted budget skips the render instead of overrunning it', async () => {
  const { fetchImpl, calls } = stubRenderApi('unused');
  const renderPage = createRenderer({ config: RENDER_CONFIG, fetchImpl });

  const rendered = await renderPage('https://example.com/', {
    budget: { deadline: Date.now() - 1 },
  });

  assert.equal(rendered.ok, false);
  assert.equal(rendered.reason, 'render_timeout');
  assert.deepEqual(calls, []);
});
