// ===== App entry =====
import * as T from './trackers.js';
import { render, tickClocks } from './render.js';
import { toast } from './format.js';
import { initInstall } from './install.js';
import * as session from './session.js';
import { openSubscribe, fmtDate } from './subscribe.js';
import { startSync, stopSync, queuePush } from './sync.js';

// Actions that need an active subscription; anything else stays free.
const PAID_ACTIONS = new Set(['calc']);

const draw = () => render(T.state);
T.setOnChange(queuePush);

/* ----- add tracker ----- */
document.getElementById('addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('newTarget');
  const x = parseFloat(input.value);
  if (!(x > 1)) { toast('Enter a multiplier above 1, for example 7'); return; }
  T.addTracker(Math.round(x * 100) / 100);
  input.value = '';
  draw();
});

/* ----- card actions (event delegation) ----- */
let pendingDelete = null, pendingTimer = null;

document.getElementById('list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const id = +btn.closest('.tracker').dataset.id;

  if (PAID_ACTIONS.has(btn.dataset.act) && !session.isActive()) {
    toast('Subscribe to unlock predictions');
    openSubscribe();
    return;
  }

  switch (btn.dataset.act) {
    case 'hit':   T.logHit(id); break;
    case 'round': T.addRound(id); break;
    case 'calc':  T.calculate(id); break;
    case 'undo':  T.undoHit(id); break;
    case 'delete':
      if (pendingDelete === id) {               // second tap confirms
        clearTimeout(pendingTimer); pendingDelete = null;
        T.removeTracker(id); toast('Tracker deleted');
        break;
      }
      pendingDelete = id;                       // first tap asks
      btn.textContent = 'Tap again to delete';
      btn.classList.add('danger');
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => { pendingDelete = null; draw(); }, 3000);
      return;                                   // don't re-render yet
  }
  draw();
});

/* ----- account: avatar, plan banner, sync ----- */
const acctBtn = document.getElementById('acctBtn');
const acctMenu = document.getElementById('acctMenu');
const banner = document.getElementById('planBanner');

function toggleMenu(open = acctMenu.hidden) {
  acctMenu.hidden = !open;
  acctBtn.setAttribute('aria-expanded', String(open));
}
acctBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
acctMenu.addEventListener('click', (e) => {
  const item = e.target.closest('[data-menu]');
  toggleMenu(false);
  if (item?.dataset.menu === 'plan') openSubscribe();
  if (item?.dataset.menu === 'signout') session.signOut();
});
document.addEventListener('click', (e) => { if (!acctMenu.hidden && !e.target.closest('.acct-wrap')) toggleMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleMenu(false); });

/** Pre-fill support emails with the account, so support can find the customer. */
function setSupportLinks(me) {
  document.querySelectorAll('a.support-link, a.btn.support').forEach((a) => {
    const url = new URL(a.href);
    url.search = `?subject=${encodeURIComponent('Aviator Tracker support')}`
      + (me ? `&body=${encodeURIComponent(`Account: ${me.email}

`)}` : '');
    a.href = url.href.replace(/\+/g, '%20');
  });
}
document.getElementById('bannerBtn').addEventListener('click', () => openSubscribe());

let syncedFor = null;

async function applyAccount(me) {
  acctBtn.hidden = !me;
  setSupportLinks(me);
  if (!me) { toggleMenu(false); stopSync(); syncedFor = null; banner.hidden = true; return; }
  document.getElementById('menuName').textContent = me.name || 'Your account';
  document.getElementById('menuEmail').textContent = me.email;
  acctBtn.innerHTML = me.picture
    ? `<img src="${me.picture.replace(/"/g, '&quot;')}" alt="" referrerpolicy="no-referrer">`
    : (me.name || '?').trim()[0].toUpperCase();
  acctBtn.title = `${me.name} · plan and account`;

  const active = session.isActive();
  const left = active ? new Date(me.expiresAt) - Date.now() : 0;
  banner.hidden = active && left > 2 * 864e5;               // show from 2 days before expiry
  document.getElementById('bannerText').textContent = active
    ? `Your plan ends ${fmtDate(me.expiresAt)}.`
    : 'No active plan. Subscribe to unlock predictions and sync.';
  document.getElementById('bannerBtn').textContent = active ? 'Renew' : 'Subscribe';
  document.getElementById('dataNote').textContent = active
    ? 'Your trackers sync to your account.'
    : 'Data stays on this device.';

  if (!active) { stopSync(); syncedFor = null; return; }
  if (syncedFor === me.id || !navigator.onLine) return;
  syncedFor = me.id;
  try {
    T.replaceState(await startSync(T.state, me.id));
    draw();
  } catch {
    syncedFor = null;                                       // try again next time the account refreshes
  }
}
session.onMeChange(applyAccount);

/* ----- live clocks ----- */
setInterval(tickClocks, 1000);

/* ----- service worker + update notice ----- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Update available', { label: 'Reload', onClick: () => nw.postMessage('skipWaiting') });
          }
        });
      });
      // Installed apps can stay open for days: look for a new service worker whenever they come back to the foreground
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!reloaded) { reloaded = true; location.reload(); }
      });
    } catch (err) {
      console.warn('Service worker registration failed:', err);
    }
  });
}

initInstall();
draw();

/* ----- launch: sign in (or resume silently), then pick up a payment returning from Paynow ----- */
const me = await session.start();
await applyAccount(me);
const ret = location.hash.match(/^#pay=([A-Z0-9-]+)$/i);
if (ret) {
  history.replaceState(null, '', location.pathname);
  openSubscribe({ reference: ret[1] });
}
