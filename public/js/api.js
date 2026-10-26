// ===== API client: every request is signed by this device's key =====
import { sign } from './device.js';

export class ApiError extends Error {
  constructor(status, body) {
    super(body.message || `Request failed (${status})`);
    Object.assign(this, { status, code: body.error, body });
  }
}

let skew = 0;                 // server clock − device clock, so a wrong phone clock can't break the proof
let onExpired = null;         // set by session.js: silently re-proves the device once, then retries

export const setExpiredHandler = (fn) => { onExpired = fn; };

export async function api(path, { method = 'GET', body, retry = true } = {}) {
  const url = '/api' + path;
  const ts = Date.now() + skew;
  const proof = `${ts}.${await sign(`${ts}.${method}.${url.split('?')[0]}`)}`;
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Device-Proof': proof, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const date = Date.parse(res.headers.get('Date'));
  if (date) skew = date - Date.now();
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;

  const err = new ApiError(res.status, data);
  if (retry && onExpired && res.status === 401 && (err.code === 'session_expired' || err.code === 'device_proof_failed')) {
    await onExpired(err);
    return api(path, { method, body, retry: false });
  }
  throw err;
}

/** True when the request never reached the server (offline, DNS, etc.). */
export const isNetworkError = (e) => !(e instanceof ApiError);
