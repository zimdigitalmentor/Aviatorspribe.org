// ===== Paynow Zimbabwe: hashing, requests, status mapping, crediting =====
import crypto from 'node:crypto';
import { config } from './config.js';
import { query, tx } from './db.js';

export const EXPRESS_URL = 'https://www.paynow.co.zw/interface/remotetransaction';
export const REDIRECT_URL = 'https://www.paynow.co.zw/interface/initiatetransaction';

/**
 * Methods offered on the subscription screen. `paynow` is the express-checkout method code;
 * redirect methods are chosen by the customer on Paynow's hosted page.
 */
export const METHODS = [
  { code: 'ecocash',   label: 'EcoCash USD',             tab: 'mobile', flow: 'express',  paynow: 'ecocash',  needsPhone: true,  processing: 'Instant' },
  { code: 'innbucks',  label: 'InnBucks',                tab: 'mobile', flow: 'express',  paynow: 'innbucks', needsPhone: true,  processing: 'Instant' },
  { code: 'paygo',     label: 'PayGo',                   tab: 'mobile', flow: 'redirect', needsPhone: false, processing: 'Via Paynow' },
  { code: 'banking',   label: 'Internet/Mobile Banking', tab: 'mobile', flow: 'redirect', needsPhone: false, processing: 'Via Paynow' },
  { code: 'zimswitch', label: 'Zimswitch',               tab: 'cards',  flow: 'redirect', needsPhone: false, processing: 'Via Paynow' },
  { code: 'visa',      label: 'Visa/Mastercard',         tab: 'cards',  flow: 'redirect', needsPhone: false, processing: 'Via Paynow', cards: true },
];

export const methodList = () => METHODS.map(({ paynow, cards, ...m }) => ({
  ...m, fee: config.feeLabel, enabled: cards ? config.paynow.cardsEnabled : true,
}));

export function paynowHash(fields, key) {
  const joined = Object.entries(fields)
    .filter(([k]) => k.toLowerCase() !== 'hash')
    .map(([, v]) => v)
    .join('');
  return crypto.createHash('sha512').update(joined + key).digest('hex').toUpperCase();
}

/** Parse a URL-encoded Paynow message, keeping field order (needed for the hash). */
export function parseMessage(body) {
  const out = {};
  for (const [k, v] of new URLSearchParams(String(body))) out[k.toLowerCase()] = v;
  return out;
}

export function validHash(msg) {
  if (!msg.hash) return false;
  const expected = Buffer.from(paynowHash(msg, config.paynow.key));
  const given = Buffer.from(String(msg.hash).toUpperCase());
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

export class PaynowError extends Error {}

/** Sign fields, POST them, parse the reply, require status=Ok and a valid reply hash. */
export async function paynowRequest(url, fields) {
  const signed = { ...fields, hash: paynowHash(fields, config.paynow.key) };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(signed).toString(),
    signal: AbortSignal.timeout(30e3),
  });
  const msg = parseMessage(await res.text());
  if (String(msg.status).toLowerCase() !== 'ok') throw new PaynowError(msg.error || `Paynow replied "${msg.status || res.status}"`);
  if (!validHash(msg)) throw new PaynowError('Paynow reply failed hash check');
  return msg;
}

/** Fetch the current status from a poll URL (Paynow's SDKs send an empty POST). */
export async function pollStatus(pollUrl) {
  const res = await fetch(pollUrl, { method: 'POST', signal: AbortSignal.timeout(20e3) });
  const msg = parseMessage(await res.text());
  if (!validHash(msg)) throw new PaynowError('Poll reply failed hash check');
  return msg;
}

export function mapStatus(s) {
  switch (String(s || '').toLowerCase()) {
    case 'paid': case 'awaiting delivery': case 'delivered': return 'paid';
    case 'cancelled': return 'cancelled';
    case 'failed': case 'disputed': case 'refunded': return 'failed';
    default: return 'pending';                              // Created, Sent, anything unknown
  }
}

const cents = (v) => Math.round(parseFloat(v) * 100);

/**
 * The one place a payment changes state. Called by the webhook and by polling with a
 * hash-checked message. Row-locked and idempotent: a paid payment is credited exactly once.
 */
export async function applyPaynowStatus(reference, msg) {
  return tx(async (c) => {
    const { rows: [p] } = await c.query('SELECT * FROM payments WHERE reference = $1 FOR UPDATE', [reference]);
    if (!p) return null;
    if (p.status === 'paid') return p.status;

    const status = mapStatus(msg.status);
    const common = [p.id, msg, msg.paynowreference || p.paynow_reference];

    if (status === 'paid') {
      if (cents(msg.amount) !== cents(p.amount_usd)) {
        console.error(`[paynow] amount mismatch on ${reference}: paid ${msg.amount}, expected ${p.amount_usd}`);
        await c.query(
          `UPDATE payments SET status = 'failed', error = 'amount_mismatch', raw_last_update = $2, paynow_reference = $3,
           updated_at = now() WHERE id = $1`, common);
        return 'failed';
      }
      await c.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [p.user_id]);  // serialise stacking
      await c.query(
        `INSERT INTO subscriptions (user_id, plan_id, payment_id, starts_at, expires_at)
         SELECT $1, pl.id, $3, s.start, s.start + make_interval(days => pl.duration_days)
         FROM plans pl,
              (SELECT greatest(now(), coalesce(max(expires_at), now())) AS start FROM subscriptions WHERE user_id = $1) s
         WHERE pl.id = $2
         ON CONFLICT (payment_id) DO NOTHING`,
        [p.user_id, p.plan_id, p.id]);
      await c.query(
        `UPDATE payments SET status = 'paid', paid_at = now(), raw_last_update = $2, paynow_reference = $3,
         error = NULL, updated_at = now() WHERE id = $1`, common);
      return 'paid';
    }

    const next = status === 'pending' ? p.status : status;    // never move a final state back to pending
    await c.query(
      `UPDATE payments SET status = $4, raw_last_update = $2, paynow_reference = $3, updated_at = now() WHERE id = $1`,
      [...common, next]);
    return next;
  });
}

/** Poll one payment row and apply the result. */
export async function pollPayment(p) {
  if (!p.poll_url) return p.status;
  await query('UPDATE payments SET last_polled_at = now() WHERE id = $1', [p.id]);
  try {
    return await applyPaynowStatus(p.reference, await pollStatus(p.poll_url));
  } catch (err) {
    console.warn(`[paynow] poll ${p.reference}: ${err.message}`);
    return p.status;
  }
}
