/**
 * Static assets, exercised through the REAL Node server adapter.
 *
 * Every other test in this suite uses `app.request()`, which invokes the Hono
 * handler directly and never touches `@hono/node-server`'s conversion from a web
 * `Response` to a Node `ServerResponse`. That gap hid a crash that killed the
 * process on the *second* static file request of its life — including
 * `/style.css`, i.e. almost every page load. 375 passing tests did not catch it.
 *
 * So these tests boot a real listener and speak real HTTP. They are slower than
 * the rest of the suite on purpose: the adapter is the thing under test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { once } from 'node:events';
import http from 'node:http';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ SITE_URL: 'https://iheartrss.com' });

/**
 * A fresh socket per request, deliberately — `agent: false`.
 *
 * Global `fetch` pools connections, and on a pooled socket the stream-lifecycle
 * bug this file exists to catch does not reproduce. A browser loading a page, and
 * curl, both open new connections; that ordering is what triggered it. Testing
 * through `fetch` here would give a green suite and a server that dies in
 * production.
 */
function get(base, path) {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: url.hostname, port: url.port, path: url.pathname, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
  });
}

async function withServer(run) {
  const app = createApp({ config });
  const server = serve({ fetch: app.fetch, port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('repeated static requests are served without killing the process', async () => {
  // The regression: request 1 succeeded, request 2 threw
  // `ERR_INVALID_STATE: ReadableStream is already closed` from undici's internals.
  // It surfaced in a microtask, so no request-scoped try/catch could contain it and
  // the whole process exited.
  await withServer(async (base) => {
    for (const path of [
      '/style.css',
      '/style.css',
      '/iheartrss.svg',
      '/iheartrss-icon.svg',
      '/favicon.ico',
      '/favicon-32x32.png',
      '/apple-touch-icon.png',
      '/site.webmanifest',
    ]) {
      const res = await get(base, path);
      assert.equal(res.status, 200, `${path} should be 200`);
      assert.ok(res.body.length > 0, `${path} should have a body`);
      assert.equal(
        Number(res.headers['content-length']),
        res.body.length,
        `${path} Content-Length must match the bytes actually sent`,
      );
    }
  });
});

test('a real page load fetches its stylesheet without incident', async () => {
  // The shape of an actual browser visit: document, then the asset it references.
  await withServer(async (base) => {
    const page = await get(base, '/');
    assert.equal(page.status, 200);
    assert.match(page.body.toString(), /\/style\.css/);

    const css = await get(base, '/style.css');
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'] ?? '', /text\/css/);
  });
});

test('src/server.js survives serving a static file', async () => {
  // The in-process tests above did NOT reproduce the crash — it only appeared when
  // running the real entrypoint, and it fired asynchronously during idle *after* a
  // successful 200, so "the next request failed" was only the corpse being found.
  //
  // Nothing short of booting the actual server catches that, so this spawns it,
  // makes one request, waits, and asserts the process is still alive. Slow and
  // unlovely; it is the only test here that would have failed before the fix.
  const { spawn } = await import('node:child_process');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'ihr-static-'));
  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, '..', 'src', 'server.js')],
    {
      env: {
        ...process.env,
        // A fixed high port, not 0: config validation requires 1..65535, so PORT=0
        // fails the boot before the listener is ever created.
        PORT: '8390',
        DATABASE_PATH: join(dir, 'test.db'),
        IP_HMAC_KEY: 'ab'.repeat(32),
        REVALIDATE_ENABLED: 'false',
        BACKUP_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  try {
    // Wait for the listening line, which carries the assigned port.
    const port = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`no listen: ${buf}`)), 15000);
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        for (const line of buf.split('\n')) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.msg === 'listening') {
              clearTimeout(timer);
              resolve(parsed.port);
            }
          } catch {
            /* partial line */
          }
        }
      });
      child.on('exit', (code) => reject(new Error(`exited early: ${code} ${buf}`)));
    });

    const res = await get(`http://127.0.0.1:${port}`, '/style.css');
    assert.equal(res.status, 200);

    // The throw landed a tick or two after the response, so give it room.
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(child.exitCode, null, 'the server must still be running');

    // And it still answers.
    assert.equal((await get(`http://127.0.0.1:${port}`, '/style.css')).status, 200);
  } finally {
    child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
