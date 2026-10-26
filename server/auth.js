// ===== Sessions, device keys and Google ID tokens =====
import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { config } from './config.js';
import { query } from './db.js';

export const COOKIE = 'at_session';
const ACCESS_MS = 24 * 3600e3;        // session must be re-proven with the device key every 24 h
const REFRESH_MS = 30 * 24 * 3600e3;  // after 30 days without use, sign in with Google again
const PROOF_SKEW_MS = 2 * 60e3;

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    Object.assign(this, { status, code, extra });
  }
}

/* ----- signed session token: base64url(json).base64url(hmac) ----- */
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (data) => crypto.createHmac('sha256', config.sessionSecret).update(data).digest();

function signToken(payload) {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${b64u(hmac(body))}`;
}

function readToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = hmac(body);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
}

const secureCookie = () => config.production || config.baseUrl.startsWith('https://');

export function setSession(res, userId, deviceId) {
  const now = Date.now();
  const token = signToken({ uid: userId, did: deviceId, exp: now + ACCESS_MS, rexp: now + REFRESH_MS });
  res.cookie(COOKIE, token, {
    httpOnly: true, secure: secureCookie(), sameSite: 'lax', path: '/', maxAge: REFRESH_MS,
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { httpOnly: true, secure: secureCookie(), sameSite: 'lax', path: '/' });
}

/** Session payload even if the 24 h access window has passed (used by /api/auth/resume). */
export function readRefreshable(req) {
  const s = readToken(req.cookies?.[COOKIE]);
  return s && s.rexp > Date.now() ? s : null;
}

/* ----- device keys (ECDSA P-256, generated non-extractable in the browser) ----- */
function canonicalJwk(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new HttpError(400, 'bad_device_key', 'Invalid device key');
  }
  return { crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y };
}

export const deviceIdOf = (jwk) =>
  crypto.createHash('sha256').update(JSON.stringify(canonicalJwk(jwk))).digest('hex');

const keyCache = new Map();
function publicKey(jwk) {
  const c = canonicalJwk(jwk), id = deviceIdOf(c);
  let key = keyCache.get(id);
  if (!key) {
    key = crypto.createPublicKey({ key: c, format: 'jwk' });
    if (keyCache.size > 5000) keyCache.clear();
    keyCache.set(id, key);
  }
  return key;
}

function verifySig(jwk, message, signatureB64u) {
  try {
    return crypto.verify('sha256', Buffer.from(message), { key: publicKey(jwk), dsaEncoding: 'ieee-p1363' },
      Buffer.from(String(signatureB64u), 'base64url'));
  } catch {
    return false;
  }
}

export async function newChallenge() {
  const nonce = crypto.randomBytes(32).toString('base64url');
  await query("INSERT INTO auth_challenges (nonce, expires_at) VALUES ($1, now() + interval '2 minutes')", [nonce]);
  return nonce;
}

/** Consume a one-time nonce and check it was signed by the given key. Returns the device id. */
export async function verifyChallenge({ nonce, signature, publicKey: jwk }) {
  const canon = canonicalJwk(jwk);
  const used = await query(
    'UPDATE auth_challenges SET used_at = now() WHERE nonce = $1 AND used_at IS NULL AND expires_at > now() RETURNING nonce',
    [String(nonce || '')]);
  if (!used.rowCount) throw new HttpError(400, 'challenge_expired', 'Sign-in took too long, please try again');
  if (!verifySig(canon, String(nonce), signature)) throw new HttpError(400, 'bad_signature', 'Device check failed');
  return { deviceId: deviceIdOf(canon), jwk: canon };
}

/* ----- Google ID tokens ----- */
const google = new OAuth2Client();

export async function verifyGoogle(idToken) {
  let p;
  try {
    const ticket = await google.verifyIdToken({ idToken: String(idToken || ''), audience: config.googleClientId });
    p = ticket.getPayload();
  } catch {
    throw new HttpError(401, 'bad_google_token', 'Google sign-in could not be verified');
  }
  if (!p?.sub || p.email_verified !== true) throw new HttpError(401, 'email_unverified', 'Google account email is not verified');
  return { sub: p.sub, email: p.email, name: p.name || p.email, picture: p.picture || null };
}

/* ----- middleware ----- */

/**
 * Valid session + proof that the request comes from the bound device.
 * Every request carries X-Device-Proof: "<ms>.<sig>" where sig signs "<ms>.<METHOD>.<path>"
 * with the device's private key, so a copied cookie is useless on another browser.
 */
export async function requireSession(req, _res, next) {
  const s = readToken(req.cookies?.[COOKIE]);
  if (!s || s.exp < Date.now()) return next(new HttpError(401, 'session_expired', 'Please sign in'));

  const { rows: [d] } = await query('SELECT user_id, public_key_jwk, revoked_at FROM devices WHERE id = $1', [s.did]);
  if (!d || d.user_id !== s.uid || d.revoked_at) {
    return next(new HttpError(401, 'device_revoked', 'This account was moved to another phone'));
  }

  const [ts, sig] = String(req.get('x-device-proof') || '').split('.');
  const path = req.originalUrl.split('?')[0];
  if (!ts || Math.abs(Date.now() - Number(ts)) > PROOF_SKEW_MS || !verifySig(d.public_key_jwk, `${ts}.${req.method}.${path}`, sig)) {
    return next(new HttpError(401, 'device_proof_failed', 'Please sign in again on this device'));
  }
  req.user = { id: s.uid, deviceId: s.did };
  next();
}

export async function isActive(userId) {
  const { rows } = await query('SELECT max(expires_at) AS exp FROM subscriptions WHERE user_id = $1', [userId]);
  const exp = rows[0].exp;
  return { active: !!exp && exp > new Date(), expiresAt: exp };
}

export async function requireActive(req, _res, next) {
  const { active } = await isActive(req.user.id);
  next(active ? undefined : new HttpError(402, 'subscription_required', 'An active subscription is required'));
}

export async function requireAdmin(req, _res, next) {
  const { rows: [u] } = await query('SELECT email FROM users WHERE id = $1', [req.user.id]);
  next(u && config.adminEmails.includes(u.email.toLowerCase()) ? undefined : new HttpError(403, 'forbidden', 'Admins only'));
}
