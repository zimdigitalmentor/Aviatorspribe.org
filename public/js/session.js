// ===== Session: Google sign-in, one-phone rule, silent re-sign-in on launch =====
import { api, ApiError, isNetworkError, setExpiredHandler } from './api.js';
import { publicJwk, sign, resetDeviceKey, deviceLabel } from './device.js';
import { isIOS, isStandalone } from './install.js';

const ME_KEY = 'aviatortracker.me';
const $ = (id) => document.getElementById(id);

export let me = null;
let appConfig = null;
const listeners = new Set();

export const onMeChange = (fn) => listeners.add(fn);

/** Subscription state comes only from the server; the cached copy is just for offline use. */
export function setMe(next) {
  me = next;
  try { next ? localStorage.setItem(ME_KEY, JSON.stringify(next)) : localStorage.removeItem(ME_KEY); } catch { /* ignore */ }
  listeners.forEach((fn) => fn(me));
}

export const isActive = () => !!me?.active && new Date(me.expiresAt) > new Date();

function cachedMe() {
  try { return JSON.parse(localStorage.getItem(ME_KEY)); } catch { return null; }
}

async function proof() {
  const { nonce } = await api('/auth/challenge', { retry: false });
  return { nonce, signature: await sign(nonce), publicKey: await publicJwk() };
}

/** Prove this device again and get a fresh 24 h session (no Google prompt). */
async function resume() {
  return api('/auth/resume', { method: 'POST', body: await proof(), retry: false });
}

setExpiredHandler(async () => {
  try {
    setMe(await resume());
  } catch (err) {
    setMe(null);
    showSignIn(err.code === 'device_revoked' ? 'This account was moved to another phone. Sign in again to continue.' : '');
    throw err;
  }
});

let resolveSignIn = null;

/** Runs on every launch. Resolves once there is a valid session (or a cached one while offline). */
export async function start() {
  try {
    setMe(await resume());
    return me;
  } catch (err) {
    const cached = cachedMe();
    if (isNetworkError(err) && cached) { me = cached; return me; }   // offline: keep working with last known state
    showSignIn(isNetworkError(err) ? 'You are offline. Connect to the internet to sign in.' : '');
  }
  return new Promise((resolve) => { resolveSignIn = resolve; });
}

function finish(profile) {
  setMe(profile);
  $('signin').hidden = true;
  document.body.classList.remove('gated');
  resolveSignIn?.(profile);
  resolveSignIn = null;
}

/* ----- sign-in screen ----- */
let gsiReady = null;

function loadGsi() {
  return gsiReady ??= (async () => {
    appConfig ??= await (await fetch('/api/config')).json();
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true; s.onload = resolve; s.onerror = reject;
      document.head.append(s);
    });
    google.accounts.id.initialize({
      client_id: appConfig.googleClientId,
      callback: (r) => onCredential(r.credential),
      use_fedcm_for_prompt: true,
      auto_select: false,
      cancel_on_tap_outside: true,
    });
  })().catch((e) => { gsiReady = null; throw e; });
}

async function renderGoogleButton() {
  const msg = $('signinMsg');
  try {
    await loadGsi();
    $('gsiBtn').innerHTML = '';
    google.accounts.id.renderButton($('gsiBtn'), {
      type: 'standard', text: 'continue_with', theme: 'filled_black', shape: 'pill', size: 'large',
      width: Math.min(320, $('gsiBtn').clientWidth || 320),
    });
    google.accounts.id.prompt();
  } catch {
    msg.textContent = 'Could not load Google sign-in. Check your connection and try again.';
  }
}

export function showSignIn(message = '') {
  document.body.classList.add('gated');
  $('signin').hidden = false;
  $('refusal').hidden = true;
  $('signinMain').hidden = false;
  $('signinMsg').textContent = message;

  // iPhone/iPad: Safari and the home-screen app keep separate storage, so they count as two phones.
  const iosBrowser = isIOS && !isStandalone();
  $('iosHint').hidden = !iosBrowser;
  $('gsiBtn').hidden = iosBrowser;
  if (!iosBrowser) renderGoogleButton();
}

$('iosAnyway').addEventListener('click', () => {
  $('iosHint').hidden = true;
  $('gsiBtn').hidden = false;
  renderGoogleButton();
});
$('iosHowBtn').addEventListener('click', () => $('iosDlg').showModal());

let lastIdToken = null;

async function deviceBody(idToken) {
  return { idToken, ...(await proof()), label: deviceLabel() };
}

async function onCredential(idToken, retried = false) {
  lastIdToken = idToken;
  const msg = $('signinMsg');
  msg.textContent = 'Signing in…';
  try {
    finish(await api('/auth/google', { method: 'POST', body: await deviceBody(idToken), retry: false }));
  } catch (err) {
    if (err.code === 'device_revoked' && !retried) {     // this phone's old key was retired after a move
      await resetDeviceKey();
      return onCredential(idToken, true);
    }
    if (err.code === 'device_mismatch' || err.code === 'device_taken') return showRefusal();
    msg.textContent = err instanceof ApiError ? err.message : 'Could not reach the server. Try again.';
  }
}

function showRefusal() {
  $('signinMain').hidden = true;
  $('refusal').hidden = false;
  $('refusalMsg').textContent = '';
}

$('otherAccount').addEventListener('click', () => {
  google.accounts.id.disableAutoSelect();
  lastIdToken = null;
  showSignIn();
});

$('moveHere').addEventListener('click', async (e) => {
  const btn = e.currentTarget, msg = $('refusalMsg');
  btn.disabled = true;
  msg.textContent = 'Moving your account to this phone…';
  try {
    finish(await api('/devices/transfer', { method: 'POST', body: await deviceBody(lastIdToken), retry: false }));
  } catch (err) {
    if (err.code === 'bad_google_token') { showSignIn('Please sign in again to confirm it is you.'); return; }
    const support = err.body?.support || appConfig?.supportContact;
    msg.textContent = (err instanceof ApiError ? err.message : 'Could not reach the server. Try again.')
      + (support && err.code !== 'bad_google_token' ? ` Support: ${support}` : '');
  } finally {
    btn.disabled = false;
  }
});

export async function signOut() {
  try { await api('/auth/logout', { method: 'POST', retry: false }); } catch { /* clear locally anyway */ }
  try { google.accounts.id.disableAutoSelect(); } catch { /* GIS not loaded */ }
  setMe(null);
  showSignIn();
}

/** Refresh profile + subscription from the server. */
export async function refreshMe() {
  setMe(await api('/me'));
  return me;
}
