// ===== Subscription screen: plan picker, Paynow methods, payment states =====
import { api, ApiError } from './api.js';
import { me, isActive, refreshMe, signOut } from './session.js';

const dlg = document.getElementById('subDlg');
const body = dlg.querySelector('.sheet-body');

let plans = [], methods = [], tab = 'all', planId = null, methodCode = null, pollTimer = null;
let view = { name: 'form' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => `$${(+v).toFixed(2)}`;
export const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const LOADER = '<div class="dots" aria-hidden="true"><i></i><i></i><i></i></div>';

const plan = () => plans.find((p) => p.id === planId);
const method = () => methods.find((m) => m.code === methodCode);

function header() {
  const status = isActive()
    ? `<span class="ok">Active until ${fmtDate(me.expiresAt)}</span>`
    : '<span class="muted">No active plan</span>';
  return `
    <div class="sheet-head">
      ${me?.picture ? `<img class="avatar" src="${esc(me.picture)}" alt="" referrerpolicy="no-referrer">` : '<span class="avatar"></span>'}
      <div class="who"><b>${esc(me?.name || 'Your account')}</b>${status}</div>
      <button class="icon-btn" data-sub="close" aria-label="Close">×</button>
    </div>`;
}

function formView() {
  const shown = methods.filter((m) => tab === 'all' || m.tab === tab);
  const m = method(), p = plan();
  return `
    <h3 class="sheet-h">Choose a plan</h3>
    <div class="plans">${plans.map((pl) => `
      <button class="plan ${pl.id === planId ? 'sel' : ''}" data-plan="${pl.id}">
        <b>${esc(pl.name)}</b><span class="price">${money(pl.priceUsd)}</span><small>${pl.durationDays} days · 1 phone</small>
      </button>`).join('')}
    </div>
    <h3 class="sheet-h">Payment method</h3>
    <div class="tabs" role="tablist">${['all', 'mobile', 'cards'].map((t) => `
      <button role="tab" aria-selected="${t === tab}" class="${t === tab ? 'sel' : ''}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
    </div>
    <div class="tiles">${shown.map((x) => `
      <button class="tile m-${x.code} ${x.code === methodCode ? 'sel' : ''}" data-method="${x.code}" ${x.enabled ? '' : 'disabled'}>
        <span>${esc(x.label)}</span>${x.enabled ? '' : '<em>Coming soon</em>'}
      </button>`).join('')}
    </div>
    ${m && p ? `
      <dl class="details">
        <div><dt>Payment name</dt><dd>${esc(m.label)}</dd></div>
        <div><dt>Fee</dt><dd>${esc(m.fee)}</dd></div>
        <div><dt>Plan price</dt><dd>${money(p.priceUsd)}</dd></div>
        <div><dt>Processing</dt><dd>${esc(m.processing)}</dd></div>
      </dl>
      ${m.needsPhone ? `
        <label class="field">${esc(m.label)} number
          <input id="payPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="07XXXXXXXX" value="${esc(me?.savedPhone || '')}">
        </label>
        <label class="check"><input id="payRemember" type="checkbox" ${me?.savedPhone ? 'checked' : ''}> Remember this number</label>` : ''}
      <button class="btn btn-hit pay" data-sub="pay">Pay ${money(p.priceUsd)}</button>
      <p class="form-msg" id="payMsg" role="alert"></p>` : '<p class="muted center">Pick a payment method to continue.</p>'}
    <button class="btn-link signout" data-sub="signout">Sign out</button>`;
}

function render() {
  let inner;
  switch (view.name) {
    case 'waiting':
      inner = `<div class="state">${LOADER}<h3>${esc(view.title)}</h3><p>${esc(view.text)}</p></div>`;
      break;
    case 'timeout':
      inner = `<div class="state"><h3>${esc(view.title)}</h3><p>${esc(view.text)}</p>
        <button class="btn btn-primary" data-sub="${view.retry ? 'again' : 'close'}">${view.retry ? 'Try again' : 'Close'}</button></div>`;
      break;
    case 'innbucks':
      inner = `<div class="state">
        <h3>Approve in InnBucks</h3>
        <p>Authorization code</p>
        <p class="code">${esc(view.code)}</p>
        ${view.expires ? `<p class="muted">Expires ${esc(view.expires)}</p>` : ''}
        <div class="qr">${view.qrSvg || ''}</div>
        <a class="btn btn-hit" href="${esc(view.deepLink)}">Open InnBucks</a>
        <div class="waiting-line">${LOADER}<span>Waiting for approval…</span></div></div>`;
      break;
    case 'success':
      inner = `<div class="state"><div class="badge ok">✓</div><h3>Payment received</h3>
        <p>Your plan is active until <b>${fmtDate(view.expiresAt || me.expiresAt)}</b>.</p>
        <button class="btn btn-primary" data-sub="close">Done</button></div>`;
      break;
    case 'failure':
      inner = `<div class="state"><div class="badge bad">!</div><h3>Payment not completed</h3>
        <p>${esc(view.reason)}</p><button class="btn btn-primary" data-sub="again">Try another method</button></div>`;
      break;
    default:
      inner = formView();
  }
  body.innerHTML = header() + inner;
}

function show(name, data = {}) { view = { name, ...data }; render(); }

function stopPoll() { clearTimeout(pollTimer); pollTimer = null; }

/** Poll our server every 3 s until the payment settles or the timeout passes. */
function poll(reference, timeoutMs, onTimeout) {
  stopPoll();
  const started = Date.now();
  const tick = async () => {
    try {
      const r = await api(`/pay/${encodeURIComponent(reference)}`);
      if (!dlg.open) return;
      if (r.status === 'paid') { await refreshMe().catch(() => {}); return show('success', { expiresAt: r.expiresAt }); }
      if (r.status !== 'pending') return show('failure', { reason: r.error || 'The payment did not go through.' });
    } catch { /* keep trying until the timeout */ }
    if (!dlg.open) return;
    if (Date.now() - started > timeoutMs) return onTimeout();
    pollTimer = setTimeout(tick, 3000);
  };
  pollTimer = setTimeout(tick, 3000);
}

async function pay() {
  const m = method(), msg = document.getElementById('payMsg');
  const btn = body.querySelector('[data-sub="pay"]');
  const phone = document.getElementById('payPhone')?.value.trim();
  if (m.needsPhone && !/^(07\d{8}|\+?2637\d{8})$/.test((phone || '').replace(/[\s-]/g, ''))) {
    msg.textContent = 'Enter a Zimbabwean mobile number like 0771234567';
    return;
  }
  btn.disabled = true;
  msg.textContent = '';
  try {
    const r = await api('/pay', {
      method: 'POST',
      body: { planId, method: m.code, phone, rememberPhone: !!document.getElementById('payRemember')?.checked },
    });
    if (r.flow === 'redirect') { location.href = r.url; return; }  // same tab: installed apps handle this best
    if (r.flow === 'innbucks') {
      show('innbucks', r);
      poll(r.reference, 15 * 60e3, () => show('timeout', { title: 'Code expired', text: 'The InnBucks code was not approved in time.', retry: true }));
      return;
    }
    show('waiting', { title: 'Check your phone', text: r.message });
    poll(r.reference, 2 * 60e3, () => show('timeout', {
      title: 'Didn’t get the prompt?', text: 'No EcoCash confirmation arrived within 2 minutes.', retry: true,
    }));
  } catch (err) {
    msg.textContent = err instanceof ApiError ? err.message : 'Could not reach the server. Check your connection.';
    btn.disabled = false;
  }
}

body.addEventListener('click', (e) => {
  const t = e.target.closest('[data-plan],[data-tab],[data-method],[data-sub]');
  if (!t || t.disabled) return;
  if (t.dataset.plan) { planId = +t.dataset.plan; render(); }
  else if (t.dataset.tab) { tab = t.dataset.tab; render(); }
  else if (t.dataset.method) { methodCode = t.dataset.method; render(); }
  else if (t.dataset.sub === 'close') dlg.close();
  else if (t.dataset.sub === 'again') { stopPoll(); show('form'); }
  else if (t.dataset.sub === 'pay') pay();
  else if (t.dataset.sub === 'signout') { dlg.close(); signOut(); }
});

dlg.addEventListener('close', stopPoll);

/** Open the screen. Pass a reference to resume watching a payment (e.g. after a Paynow redirect). */
export async function openSubscribe({ reference } = {}) {
  view = { name: 'form' };
  body.innerHTML = header() + `<div class="state">${LOADER}</div>`;
  if (!dlg.open) dlg.showModal();
  try {
    [plans, methods] = await Promise.all([api('/plans'), api('/payment-methods')]);
  } catch {
    return show('timeout', { title: 'You’re offline', text: 'Connect to the internet to subscribe.' });
  }
  planId ??= plans[0]?.id ?? null;
  if (reference) {
    show('waiting', { title: 'Payment processing…', text: 'Waiting for Paynow to confirm your payment.' });
    poll(reference, 2 * 60e3, () => show('timeout', {
      title: 'Still processing',
      text: 'Paynow has not confirmed yet. Your plan will update automatically as soon as it does.',
    }));
  } else {
    show('form');
  }
}
