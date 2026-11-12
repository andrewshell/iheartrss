/**
 * `public/nofollow.js`: member links on the blogroll and the river carry
 * `rel="nofollow ugc"`, so being listed passes no link equity.
 *
 * There is no DOM library in this repo, so the script runs in a `vm` realm against
 * minimal fakes: anchors with a real `href` string and a token-set `relList`, and a
 * `MutationObserver` the test fires by hand, the way the browser would after a
 * third-party script adds or rewrites a link.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

import { createApp } from '../src/app.js';

function anchor(href, rel = '') {
  const tokens = new Set(rel.split(/\s+/).filter(Boolean));
  return {
    href,
    relList: {
      add: (...names) => names.forEach((name) => tokens.add(name)),
      contains: (name) => tokens.has(name),
    },
    get rel() {
      return [...tokens].join(' ');
    },
  };
}

async function load(initial = []) {
  const source = await readFile(
    new URL('../public/nofollow.js', import.meta.url),
    'utf8',
  );
  const observers = [];
  const realm = createContext({
    URL,
    location: { href: 'https://iheartrss.com/river', origin: 'https://iheartrss.com' },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe(target, options) {
        this.target = target;
        this.options = options;
      }
    },
  });
  runInContext(source, realm);

  const anchors = [...initial];
  const container = { querySelectorAll: () => anchors };
  realm.nofollowMemberLinks(container);

  return {
    anchors,
    // What the browser does after a mutation inside the container.
    mutate: () => observers.forEach((o) => o.target === container && o.callback([])),
  };
}

test('off-site links get nofollow and ugc, and keep the tokens they had', async () => {
  const { anchors, mutate } = await load();
  const member = anchor('https://member.example/post');
  const plain = anchor('http://other.example/');
  const opener = anchor('https://third.example/', 'noopener');
  const ours = anchor('https://iheartrss.com/sites');
  const mail = anchor('mailto:someone@example.com');
  anchors.push(member, plain, opener, ours, mail);
  mutate();

  assert.equal(member.rel, 'nofollow ugc');
  assert.equal(plain.rel, 'nofollow ugc');
  assert.equal(opener.rel, 'noopener nofollow ugc');
  assert.equal(ours.rel, '', 'a same-origin link is left alone');
  assert.equal(mail.rel, '', 'only http(s) links are marked');
});

test('links present before the call are marked immediately', async () => {
  const member = anchor('https://member.example/');
  await load([member]);

  assert.equal(member.rel, 'nofollow ugc');
});

test('a link added later, or repointed off-site, is marked too', async () => {
  const { anchors, mutate } = await load();

  const late = anchor('https://late.example/');
  anchors.push(late);
  mutate();
  assert.equal(late.rel, 'nofollow ugc');

  const repointed = anchor('https://iheartrss.com/');
  anchors.push(repointed);
  mutate();
  assert.equal(repointed.rel, '');
  repointed.href = 'https://elsewhere.example/';
  mutate();
  assert.equal(repointed.rel, 'nofollow ugc');
});

test('the homepage and the river load nofollow.js before their starter', async () => {
  const app = createApp({ config: { siteUrl: 'https://iheartrss.com' } });

  for (const [path, starter] of [
    ['/', '/feedland-blogroll.js'],
    ['/river', '/feedland-river.js'],
  ]) {
    const html = await (await app.request(path)).text();
    const marker = html.search(
      /<script\b[^>]*src="\/nofollow\.js\?v=[0-9a-f]+"[^>]*defer/,
    );
    assert.ok(marker > -1, `${path} does not load nofollow.js deferred`);
    assert.ok(marker < html.indexOf(`src="${starter}`), `${path} loads it too late`);
  }
});
