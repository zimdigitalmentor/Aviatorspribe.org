// ===== Formatting helpers =====
import { xClass } from './math.js';

export const fmtX = (x) => (+x).toFixed(2).replace(/\.00$/, '') + 'x';
export const cX = (x) => `<span class="xm ${xClass(x)}">${fmtX(x)}</span>`;
export const pct = (v) => (v * 100).toFixed(v < 0.1 ? 1 : 0) + '%';
export const fmtClock = (t) =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h ${m}m ${r}s` : m ? `${m}m ${r}s` : `${r}s`;
}

let toastTimer;
export function toast(msg, action) {
  const el = document.getElementById('toast');
  el.innerHTML = '';
  el.append(document.createTextNode(msg));
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn btn-primary';
    b.textContent = action.label;
    b.onclick = action.onClick;
    el.append(b);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 10000 : 2200);
}
