/**
 * Plan §11: without this, the multi-tenant seed data in `001_init.sql` is the sort
 * of thing that gets dropped and is only noticed when the 6th Micro.blog user is
 * turned away.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDb } from '../src/db/index.js';
import { createPersister } from '../src/verify/persist.js';

const CONFIG = Object.freeze({
  linkbackHosts: ['iheartrss.com'],
  maxListingsPerDomain: 5,
  maxNewListingsPerDay: 50,
});

function setup(config = {}) {
  const { db, queries } = createDb(':memory:');
  const persist = createPersister({
    queries,
    config: { ...CONFIG, ...config },
    safeFetch: async () => ({ ok: false, reason: 'unexpected_fetch' }),
  });
  return { db, queries, persist };
}

function member(host, n) {
  return {
    ok: true,
    url: `https://${host}/`,
    submittedUrl: `https://${host}/`,
    feedUrl: `https://${host}/rss.xml?n=${n}`,
    title: `Member ${n}`,
    features: { has_source_ns: false, has_rsscloud: false, rsscloud_style: null },
  };
}

test('the cap refuses the 6th listing on one registrable domain', async () => {
  const { persist } = setup();

  for (let n = 1; n <= 5; n += 1) {
    const outcome = await persist(member(`user${n}.example.com`, n));
    assert.equal(outcome.outcome, 'added', `listing ${n} should be accepted`);
  }

  const sixth = await persist(member('user6.example.com', 6));
  assert.equal(sixth.outcome, 'rejected');
  assert.equal(sixth.reason, 'domain_cap');
  assert.equal(sixth.domain, 'example.com');
});

test('a domain_limits row for substack.com lets the 6th through', async () => {
  const { persist } = setup();

  // §4/§5 Step 7: with allowPrivateDomains:true, alice.substack.com still resolves
  // to substack.com — the PSL private section doesn't separate its users — so
  // without the seeded override the cap is exactly the "you're the 6th, go away"
  // outage it was meant to prevent.
  for (let n = 1; n <= 6; n += 1) {
    const outcome = await persist(member(`user${n}.substack.com`, n));
    assert.equal(outcome.outcome, 'added', `substack listing ${n} should be accepted`);
  }
});

test('the cap separates the private-suffix hosts tldts does distinguish', async () => {
  const { persist } = setup();

  // §5 Step 7, verbatim: "allowPrivateDomains: true, and that flag is not optional
  // — at the default, getDomain('anyuser.github.io') is github.io and a cap of 5
  // would limit ALL of GitHub Pages, netlify.app, pages.dev and blogspot.com to
  // five listings each, globally."
  for (const [n, host] of [
    'a.github.io',
    'b.github.io',
    'c.github.io',
    'd.github.io',
    'e.github.io',
    'f.github.io',
    'g.netlify.app',
    'h.pages.dev',
    'i.blogspot.com',
  ].entries()) {
    const outcome = await persist(member(host, n));
    assert.equal(outcome.outcome, 'added', `${host} should be accepted`);
  }
});

test('an existing member re-submitting is not refused by their own domain cap', async () => {
  const { persist } = setup({ maxListingsPerDomain: 1 });

  await persist(member('alice.example.com', 1));
  const again = await persist(member('alice.example.com', 1));

  // The cap counts NEW listings. Refusing a refresh would break §5 Step 7's
  // "safe, idempotent re-check me now" promise for every member on a capped domain.
  assert.equal(again.outcome, 'updated');
});

test('the global daily cap refuses a new listing once the day is spent', async () => {
  const { persist } = setup({ maxNewListingsPerDay: 2 });

  assert.equal((await persist(member('a.one.example', 1))).outcome, 'added');
  assert.equal((await persist(member('b.two.example', 2))).outcome, 'added');

  const third = await persist(member('c.three.example', 3));
  assert.equal(third.outcome, 'rejected');
  assert.equal(third.reason, 'daily_cap');

  // It caps *new* listings, not refreshes — §5 Step 7's second backstop is about
  // bulk flooding, and an existing member re-verifying adds nothing to flood with.
  assert.equal((await persist(member('a.one.example', 1))).outcome, 'updated');
});

test('a rejected listing writes no site row at all', async () => {
  const { db, persist } = setup({ maxNewListingsPerDay: 1 });

  await persist(member('a.one.example', 1));
  await persist(member('b.two.example', 2));

  assert.equal(db.prepare('SELECT count(*) AS n FROM sites').get().n, 1);
});

// ── §5 Step 5's exemption, at the persister ──────────────────────────────────

test('`linkbackExempt` sets the flag on a new row, and a plain resubmit leaves it alone', async () => {
  const { db, persist } = setup();

  const first = await persist(member('scripting.example', 1), { linkbackExempt: true });
  assert.equal(first.outcome, 'added');
  assert.equal(
    db.prepare('SELECT linkback_exempt FROM sites WHERE id = ?').get(first.siteId)
      .linkback_exempt,
    1,
  );

  // The flag is the operator's, not the submitter's: a public `/submit` of the same
  // site refreshes the row and must not clear it, or the next scheduler tick reads
  // the site as an opt-out.
  const again = await persist(member('scripting.example', 1));
  assert.equal(again.outcome, 'updated');
  assert.equal(
    db.prepare('SELECT linkback_exempt FROM sites WHERE id = ?').get(first.siteId)
      .linkback_exempt,
    1,
  );

  // And a row that was never exempt stays that way through a normal update.
  const plain = await persist(member('plain.example', 2));
  await persist(member('plain.example', 2));
  assert.equal(
    db.prepare('SELECT linkback_exempt FROM sites WHERE id = ?').get(plain.siteId)
      .linkback_exempt,
    0,
  );
});

test('`skipCaps` lets the admin past the per-domain and daily caps, not past a ban', async () => {
  const { queries, persist } = setup({
    maxListingsPerDomain: 1,
    maxNewListingsPerDay: 1,
  });

  assert.equal((await persist(member('user1.example.com', 1))).outcome, 'added');

  const capped = await persist(member('user2.example.com', 2));
  assert.equal(capped.reason, 'domain_cap');

  const allowed = await persist(member('user2.example.com', 2), {
    linkbackExempt: true,
    skipCaps: true,
  });
  assert.equal(allowed.outcome, 'added');

  // The caps are anti-flood backstops and one operator is not a flood; a ban is a
  // decision, and the same operator's allow form does not silently reverse it.
  queries.insertBan({ host: 'banned.example', host_suffix: '', path_prefix: '' });
  const banned = await persist(member('banned.example', 3), {
    linkbackExempt: true,
    skipCaps: true,
  });
  assert.equal(banned.outcome, 'rejected');
  assert.equal(banned.reason, 'banned');
});
