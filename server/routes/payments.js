// ===== Plans, payment methods, /pay and the Paynow callbacks =====
import crypto from 'node:crypto';
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { query } from '../db.js';
import { HttpError, requireSession, isActive } from '../auth.js';
import { normalisePhone } from './account.js';
import {
  METHODS, methodList, paynowRequest, PaynowError, EXPRESS_URL, REDIRECT_URL,
  parseMessage, validHash, applyPaynowStatus, pollPayment,
} from '../paynow.js';

const router = Router();

router.get('/plans', async (_req, res) => {
  const { rows } = await query(
    'SELECT id, code, name, price_usd AS "priceUsd", duration_days AS "durationDays" FROM plans WHERE active ORDER BY sort_order, id');
  res.json(rows);
});

router.get('/payment-methods', (_req, res) => res.json(methodList()));

const payLimit = rateLimit({
  windowMs: 10 * 60e3, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false,
  keyGenerator: (req) => req.user.id,
  handler: (_req, res) => res.status(429).json({ error: 'too_many_payments', message: 'Too many payment attempts. Please wait a few minutes.' }),
});

const newReference = () => `AT-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

/** Start a payment. The amount always comes from the plans table, never from the request. */
router.post('/pay', requireSession, payLimit, async (req, res) => {
  const method = METHODS.find((m) => m.code === req.body.method);
  if (!method || !methodList().find((m) => m.code === method.code).enabled) {
    throw new HttpError(400, 'bad_method', 'That payment method is not available');
  }
  const { rows: [plan] } = await query('SELECT * FROM plans WHERE id = $1 AND active', [Number(req.body.planId)]);
  if (!plan) throw new HttpError(400, 'bad_plan', 'That plan is not available');
  if (!config.paynow.id || !config.paynow.key) throw new HttpError(503, 'payments_unconfigured', 'Payments are not set up yet');

  const phone = method.needsPhone ? normalisePhone(req.body.phone || '') : null;
  const { rows: [user] } = await query('SELECT email FROM users WHERE id = $1', [req.user.id]);
  if (phone && req.body.rememberPhone) await query('UPDATE users SET saved_phone = $2 WHERE id = $1', [req.user.id, phone]);

  const reference = newReference();
  const { rows: [pay] } = await query(
    `INSERT INTO payments (user_id, plan_id, reference, method, amount_usd, phone)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [req.user.id, plan.id, reference, method.code, plan.price_usd, phone]);

  // Field order matters: the hash is computed over values in this order.
  const fields = {
    id: config.paynow.id,
    reference,
    amount: plan.price_usd,
    additionalinfo: `Aviator Tracker ${plan.name}`,
    returnurl: `${config.baseUrl}/api/paynow/return?ref=${reference}`,
    resulturl: `${config.baseUrl}/api/paynow/result`,
    authemail: config.paynow.mode === 'test' ? config.paynow.testAuthEmail : user.email,
  };
  if (method.flow === 'express') Object.assign(fields, { phone, method: method.paynow });
  fields.status = 'Message';

  let reply;
  try {
    reply = await paynowRequest(method.flow === 'express' ? EXPRESS_URL : REDIRECT_URL, fields);
  } catch (err) {
    const message = err instanceof PaynowError ? err.message : 'Could not reach Paynow';
    console.warn(`[pay] ${reference}: ${err.message}`);
    await query("UPDATE payments SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [pay.id, message]);
    throw new HttpError(502, 'paynow_error', message);
  }

  await query(
    `UPDATE payments SET poll_url = $2, browser_url = $3, paynow_reference = $4,
       innbucks_code = $5, innbucks_expires = $6, raw_last_update = $7, updated_at = now() WHERE id = $1`,
    [pay.id, reply.pollurl || null, reply.browserurl || null, reply.paynowreference || null,
      reply.authorizationcode || null, reply.authorizationexpires || null, reply]);

  if (method.code === 'ecocash') {
    return res.json({ reference, flow: 'ecocash', message: 'Check your phone and enter your EcoCash PIN' });
  }
  if (method.code === 'innbucks') {
    const code = reply.authorizationcode;
    return res.json({
      reference, flow: 'innbucks', code, expires: reply.authorizationexpires,
      deepLink: `com.innbucks.customer://purchase?paymentToken=${encodeURIComponent(code)}`,
      qrSvg: await QRCode.toString(code, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
    });
  }
  res.json({ reference, flow: 'redirect', url: reply.browserurl });
});

/** Status from our DB (the app polls every 3 s). Nudges a Paynow poll so dev works without a webhook. */
router.get('/pay/:reference', requireSession, async (req, res) => {
  const { rows: [p] } = await query('SELECT * FROM payments WHERE reference = $1 AND user_id = $2', [req.params.reference, req.user.id]);
  if (!p) throw new HttpError(404, 'not_found', 'Payment not found');
  let status = p.status;
  if (status === 'pending' && (!p.last_polled_at || Date.now() - p.last_polled_at > 5e3)) status = await pollPayment(p);
  const sub = status === 'paid' ? await isActive(req.user.id) : null;
  res.json({
    reference: p.reference, method: p.method, status,
    error: p.error || (status === 'cancelled' ? 'The payment was cancelled' : status === 'failed' ? 'The payment failed' : null),
    expiresAt: sub?.expiresAt || null,
  });
});

/** Paynow status webhook. Hash-checked; replies 200 quickly either way. */
router.post('/paynow/result', express.text({ type: '*/*', limit: '20kb' }), async (req, res) => {
  const msg = parseMessage(req.body);
  if (!validHash(msg)) {
    console.warn('[paynow] webhook hash mismatch, dropped', msg.reference);
    return res.status(200).send('ignored');
  }
  res.status(200).send('ok');
  applyPaynowStatus(msg.reference, msg).catch((err) => console.error('[paynow] webhook apply failed', err));
});

/** Customer lands here after a redirect payment; poll once, then bounce into the app. */
router.get('/paynow/return', async (req, res) => {
  const ref = String(req.query.ref || '').replace(/[^A-Z0-9-]/gi, '').slice(0, 40);
  if (ref) {
    const { rows: [p] } = await query('SELECT * FROM payments WHERE reference = $1', [ref]);
    if (p?.status === 'pending') await pollPayment(p);
  }
  const target = ref ? `/#pay=${ref}` : '/';
  res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="2;url=${target}"><title>Payment processing…</title>
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;
background:#000;color:#fff;font:500 18px system-ui,sans-serif}a{color:#E50539}</style></head>
<body><p>Payment processing…</p><a href="${target}">Return to Aviator Tracker</a></body></html>`);
});

export default router;
