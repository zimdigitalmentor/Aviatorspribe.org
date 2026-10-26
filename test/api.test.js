// End-to-end API tests against a real PostgreSQL database, with Google and Paynow stubbed.
// Usage: TEST_DATABASE_URL=postgres://postgres@localhost:5432/aviator_test npm test
// WARNING: the test database is wiped on every run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const DB = process.env.TEST_DATABASE_URL;
if (!DB) {
  test('api tests', { skip: 'set TEST_DATABASE_URL to run' }, () => {});
} else {
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: DB, SESSION_SECRET: 'x'.repeat(40), GOOGLE_CLIENT_ID: 'test-client',
    PUBLIC_BASE_URL: 'http://localhost', PAYNOW_INTEGRATION_ID: '1234', PAYNOW_INTEGRATION_KEY: 'test-key',
    PAYNOW_MODE: 'test', PAYNOW_TEST_AUTHEMAIL: 'merchant@example.com', ADMIN_EMAILS: 'admin@example.com', RUN_JOBS: 'false', AUTH_RATE_LIMIT: '1000',
  });
  await suite();
}

async function suite() {
  const { OAuth2Client } = await import('google-auth-library');
  // ID token "sub|email" is accepted as-is
  OAuth2Client.prototype.verifyIdToken = async function ({ idToken, audience }) {
    assert.equal(audience, 'test-client');
    const [sub, email] = idToken.split('|');
    if (!email) throw new Error('bad token');
    return { getPayload: () => ({ sub, email, email_verified: true, name: sub }) };
  };

  const { pool, migrate, query } = await import('../server/db.js');
  const { createApp } = await import('../server/app.js');
  const { paynowHash } = await import('../server/paynow.js');
  const jobs = await import('../server/jobs.js');

  /* ----- fake Paynow ----- */
  const KEY = 'test-key';
  const fake = new Map();                         // reference -> { status, amount }
  const signMsg = (fields) => new URLSearchParams({ ...fields, hash: paynowHash(fields, KEY) }).toString();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (!String(url).startsWith('https://www.paynow.co.zw/')) return realFetch(url, opts);
    const u = new URL(url);
    if (u.pathname.startsWith('/interface/')) {
      const sent = Object.fromEntries(new URLSearchParams(opts.body));
      assert.equal(sent.hash, paynowHash(sent, KEY), 'request hash');
      assert.equal(sent.authemail, 'merchant@example.com');
      fake.set(sent.reference, { status: 'Sent', amount: sent.amount });
      const reply = { status: 'Ok', pollurl: `https://www.paynow.co.zw/poll?ref=${sent.reference}`, paynowreference: '999' };
      if (u.pathname.endsWith('initiatetransaction')) reply.browserurl = `https://www.paynow.co.zw/Payment/${sent.reference}`;
      if (sent.method === 'innbucks') Object.assign(reply, { authorizationcode: '123456789', authorizationexpires: '26-Oct-2026 14:05' });
      return new Response(signMsg(reply));
    }
    const ref = u.searchParams.get('ref'), f = fake.get(ref);
    return new Response(signMsg({ reference: ref, paynowreference: '999', amount: f.amount, status: f.status, pollurl: String(url) }));
  };

  let base, server;
  before(async () => {
    await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate();
    server = createApp().listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { server?.close(); await pool.end(); });

  /* ----- a "phone": its own key pair and cookie jar ----- */
  async function phone() {
    const kp = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const { kty, crv, x, y } = await crypto.webcrypto.subtle.exportKey('jwk', kp.publicKey);
    const sign = async (t) => Buffer.from(await crypto.webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, Buffer.from(t))).toString('base64url');
    const p = { cookie: '', jwk: { kty, crv, x, y }, sign };
    p.req = async (method, path, body, { proof = true, as = p } = {}) => {
      const ts = Date.now();
      const headers = { cookie: p.cookie };
      if (proof) headers['x-device-proof'] = `${ts}.${await as.sign(`${ts}.${method}.${'/api' + path.split('?')[0]}`)}`;
      if (body) headers['content-type'] = 'application/json';
      const res = await realFetch(base + '/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) p.cookie = set.split(';')[0];
      return { status: res.status, setCookie: !!set, body: await res.json().catch(() => null) };
    };
    p.proofBody = async () => {
      const { body: { nonce } } = await p.req('GET', '/auth/challenge');
      return { nonce, signature: await sign(nonce), publicKey: p.jwk, label: 'Test · Node' };
    };
    p.signIn = async (who) => p.req('POST', '/auth/google', { idToken: `${who}|${who}@example.com`, ...(await p.proofBody()) });
    p.transfer = async (who) => p.req('POST', '/devices/transfer', { idToken: `${who}|${who}@example.com`, ...(await p.proofBody()) });
    return p;
  }

  async function subscriber(who) {
    const p = await phone();
    assert.equal((await p.signIn(who)).status, 200);
    return p;
  }

  /** Change what fake Paynow reports and let the next status check poll straight away. */
  async function settle(ref, status, amount) {
    Object.assign(fake.get(ref), { status }, amount ? { amount } : {});
    await query('UPDATE payments SET last_polled_at = NULL WHERE reference = $1', [ref]);
  }

  const days = (iso) => Math.round((new Date(iso) - Date.now()) / 864e5);
  const plan = async (p) => (await p.req('GET', '/plans')).body[0];

  /* ===== sign-in and the one-device rule ===== */

  test('first sign-in registers the device; same phone signs in again', async () => {
    const a = await phone();
    const r1 = await a.signIn('alice');
    assert.equal(r1.status, 200);
    assert.equal(r1.body.active, false);
    assert.equal((await a.req('GET', '/me')).status, 200);
    assert.equal((await a.signIn('alice')).status, 200);
  });

  test('one-device rule, cookie copying, transfer and admin reset', async () => {
    const a = await subscriber('bob');
    const b = await phone();

    const mismatch = await b.signIn('bob');
    assert.equal(mismatch.status, 403);
    assert.equal(mismatch.body.error, 'device_mismatch');
    assert.equal(mismatch.setCookie, false, 'no session on refusal');

    const taken = await a.signIn('carol');
    assert.equal(taken.status, 403);
    assert.equal(taken.body.error, 'device_taken');

    // copied cookie: right cookie, wrong key / no key
    b.cookie = a.cookie;
    assert.equal((await b.req('GET', '/me')).body.error, 'device_proof_failed');
    assert.equal((await b.req('GET', '/me', null, { proof: false })).status, 401);
    b.cookie = '';

    // silent resume on launch
    assert.equal((await a.req('POST', '/auth/resume', await a.proofBody())).status, 200);

    // move to phone b: old phone is signed out at once
    assert.equal((await b.transfer('bob')).status, 200);
    assert.equal((await b.req('GET', '/me')).status, 200);
    const old = await a.req('GET', '/me');
    assert.equal(old.status, 401);
    assert.equal(old.body.error, 'device_revoked');
    assert.equal((await a.req('POST', '/auth/resume', await a.proofBody())).status, 401);

    // second move within 30 days is refused
    const c = await phone();
    const again = await c.transfer('bob');
    assert.equal(again.status, 403);
    assert.equal(again.body.error, 'transfer_too_soon');

    // admin reset unlocks it
    const admin = await subscriber('admin');
    assert.equal((await b.req('POST', '/admin/users/bob@example.com/reset-device')).status, 403, 'non-admin refused');
    const reset = await admin.req('POST', '/admin/users/bob@example.com/reset-device');
    assert.equal(reset.status, 200);
    assert.equal(reset.body.devicesRevoked, 1);
    assert.equal((await c.signIn('bob')).status, 200);
  });

  test('challenges are single-use', async () => {
    const p = await phone();
    const body = { idToken: 'dave|dave@example.com', ...(await p.proofBody()) };
    assert.equal((await p.req('POST', '/auth/google', body)).status, 200);
    assert.equal((await p.req('POST', '/auth/google', body)).body.error, 'challenge_expired');
  });

  test('logout clears the session', async () => {
    const p = await subscriber('erin');
    await p.req('POST', '/auth/logout');
    assert.equal((await p.req('GET', '/me')).status, 401);
  });

  /* ===== plans, methods, payments ===== */

  test('plans and payment methods', async () => {
    const p = await phone();
    const plans = (await p.req('GET', '/plans')).body;
    assert.deepEqual(plans.map((x) => [x.code, x.priceUsd, x.durationDays]), [['monthly', '10.00', 30]]);
    const methods = (await p.req('GET', '/payment-methods')).body;
    assert.deepEqual(methods.map((m) => m.code), ['ecocash', 'innbucks', 'paygo', 'banking', 'zimswitch', 'visa']);
    assert.equal(methods.find((m) => m.code === 'visa').enabled, false);
  });

  test('EcoCash: pay, credit once, early renewal stacks', async () => {
    const p = await subscriber('frank');
    const { id: planId } = await plan(p);
    assert.equal((await p.req('GET', '/trackers')).status, 402, 'trackers need a subscription');
    assert.equal((await p.req('POST', '/pay', { planId, method: 'ecocash', phone: '12345' })).body.error, 'bad_phone');

    const r = await p.req('POST', '/pay', { planId, method: 'ecocash', phone: '+263 771 111 111', amount: 0.01, rememberPhone: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.flow, 'ecocash');
    assert.equal((await query('SELECT amount_usd, phone FROM payments WHERE reference = $1', [r.body.reference])).rows[0].amount_usd, '10.00', 'amount from plans, not request');
    assert.equal((await p.req('GET', `/pay/${r.body.reference}`)).body.status, 'pending');

    await settle(r.body.reference, 'Paid');
    const paid = await p.req('GET', `/pay/${r.body.reference}`);
    assert.equal(paid.body.status, 'paid');
    assert.equal(days(paid.body.expiresAt), 30);
    const me = (await p.req('GET', '/me')).body;
    assert.equal(me.active, true);
    assert.equal(me.savedPhone, '0771111111');

    // webhook arriving after the poll credits nothing extra
    const hook = await realFetch(`${base}/api/paynow/result`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: signMsg({ reference: r.body.reference, paynowreference: '999', amount: '10.00', status: 'Paid', pollurl: 'x' }),
    });
    assert.equal(hook.status, 200);
    await new Promise((res) => setTimeout(res, 200));
    const subs = await query('SELECT count(*)::int AS n FROM subscriptions s JOIN payments p ON p.id = s.payment_id WHERE p.reference = $1', [r.body.reference]);
    assert.equal(subs.rows[0].n, 1);

    // early renewal: Awaiting Delivery also means paid
    const r2 = await p.req('POST', '/pay', { planId, method: 'ecocash', phone: '0771111111' });
    await settle(r2.body.reference, 'Awaiting Delivery');
    assert.equal(days((await p.req('GET', `/pay/${r2.body.reference}`)).body.expiresAt), 60);
  });

  test('webhook: tampered hash is dropped, valid one credits', async () => {
    const p = await subscriber('gina');
    const r = await p.req('POST', '/pay', { planId: (await plan(p)).id, method: 'ecocash', phone: '0772222222' });
    const fields = { reference: r.body.reference, paynowreference: '999', amount: '10.00', status: 'Paid', pollurl: 'x' };
    const post = (b) => realFetch(`${base}/api/paynow/result`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: b });

    await post(new URLSearchParams({ ...fields, hash: 'AB'.repeat(64) }).toString());
    await new Promise((res) => setTimeout(res, 200));
    assert.equal((await query('SELECT status FROM payments WHERE reference = $1', [r.body.reference])).rows[0].status, 'pending');

    await post(signMsg(fields));
    await new Promise((res) => setTimeout(res, 200));
    assert.equal((await query('SELECT status FROM payments WHERE reference = $1', [r.body.reference])).rows[0].status, 'paid');
  });

  test('amount mismatch is not credited; cancel maps to cancelled', async () => {
    const p = await subscriber('hank');
    const planId = (await plan(p)).id;
    const r = await p.req('POST', '/pay', { planId, method: 'ecocash', phone: '0771111111' });
    await settle(r.body.reference, 'Paid', '1.00');
    assert.equal((await p.req('GET', `/pay/${r.body.reference}`)).body.status, 'failed');
    assert.equal((await p.req('GET', '/me')).body.active, false);

    const c = await p.req('POST', '/pay', { planId, method: 'ecocash', phone: '0773333333' });
    await settle(c.body.reference, 'Cancelled');
    assert.equal((await p.req('GET', `/pay/${c.body.reference}`)).body.status, 'cancelled');
  });

  test('InnBucks, redirect methods, disabled cards, other users\' payments', async () => {
    const p = await subscriber('ivan');
    const planId = (await plan(p)).id;
    const ib = await p.req('POST', '/pay', { planId, method: 'innbucks', phone: '0771234567' });
    assert.equal(ib.body.flow, 'innbucks');
    assert.equal(ib.body.code, '123456789');
    assert.equal(ib.body.deepLink, 'com.innbucks.customer://purchase?paymentToken=123456789');
    assert.match(ib.body.qrSvg, /^<svg/);

    const rd = await p.req('POST', '/pay', { planId, method: 'paygo' });
    assert.equal(rd.body.flow, 'redirect');
    assert.match(rd.body.url, /^https:\/\/www\.paynow\.co\.zw\/Payment\//);

    assert.equal((await p.req('POST', '/pay', { planId, method: 'visa' })).body.error, 'bad_method');

    const other = await subscriber('judy');
    assert.equal((await other.req('GET', `/pay/${ib.body.reference}`)).status, 404);

    await settle(rd.body.reference, 'Paid');
    const ret = await realFetch(`${base}/api/paynow/return?ref=${rd.body.reference}`);
    assert.match(await ret.text(), new RegExp(`url=/#pay=${rd.body.reference}`));
    assert.equal((await p.req('GET', '/me')).body.active, true);
  });

  test('/api/pay is rate-limited per user', async () => {
    const p = await subscriber('kate');
    const planId = (await plan(p)).id;
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await p.req('POST', '/pay', { planId, method: 'paygo' })).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
  });

  test('jobs: polling credits without a webhook; stale payments expire', async () => {
    const p = await subscriber('liam');
    const planId = (await plan(p)).id;
    const a = await p.req('POST', '/pay', { planId, method: 'ecocash', phone: '0771111111' });
    const b = await p.req('POST', '/pay', { planId, method: 'ecocash', phone: '0771111111' });
    await query("UPDATE payments SET created_at = now() - interval '1 minute' WHERE reference = $1", [a.body.reference]);
    await query("UPDATE payments SET created_at = now() - interval '16 minutes' WHERE reference = $1", [b.body.reference]);
    await settle(a.body.reference, 'Paid');
    await jobs.pollPending();
    await jobs.expireStale();
    const st = async (ref) => (await query('SELECT status FROM payments WHERE reference = $1', [ref])).rows[0].status;
    assert.equal(await st(a.body.reference), 'paid');
    assert.equal(await st(b.body.reference), 'expired');
  });

  /* ===== tracker sync ===== */

  test('trackers round-trip for subscribers', async () => {
    const p = await subscriber('mia');
    const r = await p.req('POST', '/pay', { planId: (await plan(p)).id, method: 'ecocash', phone: '0771111111' });
    await settle(r.body.reference, 'Paid');
    await p.req('GET', `/pay/${r.body.reference}`);

    const t = [
      { id: 1761480000000, target: 7, hits: [{ t: 1, rounds: null }, { t: 2, rounds: 12 }], roundsSince: 3,
        projection: { interval: 1, dueTime: 3, dueRounds: 12, made: 2 }, scores: [{ ok: true, detail: 'x' }] },
      { id: 1761480000001, target: 1.5, hits: [], roundsSince: 0, projection: null, scores: [] },
    ];
    assert.equal((await p.req('PUT', '/trackers', { trackers: t })).status, 200);
    assert.deepEqual((await p.req('GET', '/trackers')).body.trackers, t);
    assert.equal((await p.req('PUT', '/trackers', { trackers: [t[1]] })).status, 200);
    assert.deepEqual((await p.req('GET', '/trackers')).body.trackers, [t[1]]);
    assert.equal((await p.req('PUT', '/trackers', { trackers: [{ ...t[1], target: 1 }] })).status, 400);
  });
}
