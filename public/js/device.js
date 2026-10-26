// ===== Device key: non-extractable ECDSA P-256 pair kept in IndexedDB =====
// The private key can sign but never be exported, so the account can't be copied to another phone.
const DB = 'aviatortracker', STORE = 'keys', KEY_ID = 'device';
let cached = null;

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const t = open.result.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => { open.result.close(); resolve(req.result); };
      t.onerror = () => reject(t.error);
    };
  });
}

async function keyPair() {
  if (cached) return cached;
  let kp = await idb('readonly', (s) => s.get(KEY_ID));
  if (!kp) {
    kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    await idb('readwrite', (s) => s.put(kp, KEY_ID));
  }
  return (cached = kp);
}

export async function publicJwk() {
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', (await keyPair()).publicKey);
  return { kty, crv, x, y };
}

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function sign(text) {
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, (await keyPair()).privateKey,
    new TextEncoder().encode(text));
  return b64u(sig);
}

/** Retire this key (server revoked it); a new one is made on next use. */
export async function resetDeviceKey() {
  cached = null;
  await idb('readwrite', (s) => s.delete(KEY_ID));
}

/** Readable name such as "Android · Chrome". */
export function deviceLabel() {
  const ua = navigator.userAgent;
  const ipad = /ipad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const os = /android/i.test(ua) ? 'Android' : /iphone|ipod/i.test(ua) ? 'iPhone' : ipad ? 'iPad'
    : /windows/i.test(ua) ? 'Windows' : /cros/i.test(ua) ? 'ChromeOS' : /mac/i.test(ua) ? 'Mac'
    : /linux/i.test(ua) ? 'Linux' : 'Device';
  const br = /edg/i.test(ua) ? 'Edge' : /opr|opera/i.test(ua) ? 'Opera' : /samsungbrowser/i.test(ua) ? 'Samsung Internet'
    : /firefox|fxios/i.test(ua) ? 'Firefox' : /crios|chrome/i.test(ua) ? 'Chrome' : /safari/i.test(ua) ? 'Safari' : 'Browser';
  const app = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return `${os} · ${br}${app ? ' (app)' : ''}`;
}
