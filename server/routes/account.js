// ===== Google sign-in, one-device rule, transfers, /me, admin reset =====
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import {
  HttpError, newChallenge, verifyChallenge, verifyGoogle, setSession, clearSession,
  readRefreshable, requireSession, requireAdmin, isActive,
} from '../auth.js';

const router = Router();
const limiter = (limit) => rateLimit({
  windowMs: 10 * 60e3, limit, standardHeaders: 'draft-8', legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Please wait a few minutes.' }),
});
const authLimit = limiter(config.authRateLimit);        // Google sign-in and phone moves
const proofLimit = limiter(config.authRateLimit * 3);   // challenges and silent resume on launch
const TRANSFER_COOLDOWN_DAYS = 30;

const cleanLabel = (l) => String(l || 'Unknown device').slice(0, 60);

async function upsertUser(c, g) {
  const { rows: [u] } = await c.query(
    `INSERT INTO users (google_sub, email, name, picture_url) VALUES ($1, $2, $3, $4)
     ON CONFLICT (google_sub) DO UPDATE
       SET email = EXCLUDED.email, name = EXCLUDED.name, picture_url = EXCLUDED.picture_url, last_login_at = now()
     RETURNING id`,
    [g.sub, g.email, g.name, g.picture]);
  await c.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [u.id]);  // serialise device changes per account
  return u.id;
}

export async function profile(userId) {
  const { rows: [u] } = await query('SELECT id, email, name, picture_url, saved_phone FROM users WHERE id = $1', [userId]);
  const { active, expiresAt } = await isActive(userId);
  const { rows: [plan] } = await query(
    `SELECT p.code, p.name FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = $1 ORDER BY s.expires_at DESC LIMIT 1`, [userId]);
  return {
    id: u.id, email: u.email, name: u.name, picture: u.picture_url, savedPhone: u.saved_phone,
    active, expiresAt, plan: plan || null,
    admin: config.adminEmails.includes(u.email.toLowerCase()),
  };
}

router.get('/auth/challenge', proofLimit, async (_req, res) => {
  res.json({ nonce: await newChallenge() });
});

/** Sign in: Google ID token + signed challenge from this device's key. */
router.post('/auth/google', authLimit, async (req, res) => {
  const g = await verifyGoogle(req.body.idToken);
  const { deviceId, jwk } = await verifyChallenge(req.body);

  const userId = await tx(async (c) => {
    const uid = await upsertUser(c, g);
    const { rows: [dev] } = await c.query('SELECT user_id, revoked_at FROM devices WHERE id = $1 FOR UPDATE', [deviceId]);
    if (dev?.revoked_at) throw new HttpError(403, 'device_revoked', 'This device key was retired');
    if (dev && dev.user_id !== uid) throw new HttpError(403, 'device_taken', 'This phone is registered to another account');
    if (dev) {
      await c.query('UPDATE devices SET last_seen_at = now(), label = $2 WHERE id = $1', [deviceId, cleanLabel(req.body.label)]);
      return uid;
    }
    const { rowCount: hasDevice } = await c.query('SELECT 1 FROM devices WHERE user_id = $1 AND revoked_at IS NULL', [uid]);
    if (hasDevice) throw new HttpError(403, 'device_mismatch', 'This account is registered to another phone');
    await c.query('INSERT INTO devices (id, user_id, public_key_jwk, label) VALUES ($1, $2, $3, $4)',
      [deviceId, uid, jwk, cleanLabel(req.body.label)]);
    return uid;
  });

  setSession(res, userId, deviceId);
  res.json(await profile(userId));
});

/** Silent re-sign-in on launch: existing (≤30 day) session + fresh signature from the same device. */
router.post('/auth/resume', proofLimit, async (req, res) => {
  const s = readRefreshable(req);
  if (!s) throw new HttpError(401, 'session_expired', 'Please sign in');
  const { deviceId } = await verifyChallenge(req.body);
  if (deviceId !== s.did) throw new HttpError(401, 'device_proof_failed', 'Please sign in again on this device');
  const { rowCount } = await query(
    'UPDATE devices SET last_seen_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [deviceId, s.uid]);
  if (!rowCount) { clearSession(res); throw new HttpError(401, 'device_revoked', 'This account was moved to another phone'); }
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [s.uid]);
  setSession(res, s.uid, deviceId);
  res.json(await profile(s.uid));
});

router.post('/auth/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

/** Move the account to this phone. Allowed once per 30 days; the old phone is signed out at once. */
router.post('/devices/transfer', authLimit, async (req, res) => {
  const g = await verifyGoogle(req.body.idToken);
  const { deviceId, jwk } = await verifyChallenge(req.body);

  const userId = await tx(async (c) => {
    const uid = await upsertUser(c, g);
    const { rows: [dev] } = await c.query('SELECT user_id, revoked_at FROM devices WHERE id = $1 FOR UPDATE', [deviceId]);
    if (dev?.revoked_at) throw new HttpError(403, 'device_revoked', 'This device key was retired');
    if (dev && dev.user_id !== uid) {
      throw new HttpError(403, 'device_taken', 'This phone is registered to another account. Contact support to move it.',
        { support: config.supportContact });
    }
    if (dev) return uid;                                   // already this account's phone

    const { rows: [recent] } = await c.query(
      `SELECT created_at FROM device_transfers WHERE user_id = $1 AND created_at > now() - make_interval(days => $2)
       ORDER BY created_at DESC LIMIT 1`, [uid, TRANSFER_COOLDOWN_DAYS]);
    if (recent) {
      throw new HttpError(403, 'transfer_too_soon', 'You moved this account recently. Contact support to move it again.',
        { support: config.supportContact });
    }
    const { rows: [old] } = await c.query(
      'UPDATE devices SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id', [uid]);
    await c.query('INSERT INTO devices (id, user_id, public_key_jwk, label) VALUES ($1, $2, $3, $4)',
      [deviceId, uid, jwk, cleanLabel(req.body.label)]);
    await c.query('INSERT INTO device_transfers (user_id, from_device_id, to_device_id) VALUES ($1, $2, $3)',
      [uid, old?.id || null, deviceId]);
    return uid;
  });

  setSession(res, userId, deviceId);
  res.json(await profile(userId));
});

router.get('/me', requireSession, async (req, res) => {
  res.json(await profile(req.user.id));
});

router.put('/me/phone', requireSession, async (req, res) => {
  const phone = req.body.phone ? normalisePhone(req.body.phone) : null;
  await query('UPDATE users SET saved_phone = $2 WHERE id = $1', [req.user.id, phone]);
  res.json({ ok: true });
});

/** Admin: release the account's phone so the owner can sign in on a new one. :id is a user id or email. */
router.post('/admin/users/:id/reset-device', requireSession, requireAdmin, async (req, res) => {
  res.json(await resetDevice(req.params.id));
});

export async function resetDevice(idOrEmail) {
  const { rows: [u] } = await query(
    'SELECT id, email FROM users WHERE id::text = $1 OR lower(email) = lower($1)', [String(idOrEmail)]);
  if (!u) throw new HttpError(404, 'not_found', 'No such user');
  const { rowCount } = await query('UPDATE devices SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);
  return { userId: u.id, email: u.email, devicesRevoked: rowCount };
}

/** Zimbabwean mobile number as 07XXXXXXXX (accepts +263 / 263 prefixes). */
export function normalisePhone(raw) {
  let p = String(raw).replace(/[\s-]/g, '');
  if (/^\+?263\d{9}$/.test(p)) p = '0' + p.replace(/^\+?263/, '');
  if (!/^07\d{8}$/.test(p)) throw new HttpError(400, 'bad_phone', 'Enter a Zimbabwean mobile number like 0771234567');
  return p;
}

export default router;
