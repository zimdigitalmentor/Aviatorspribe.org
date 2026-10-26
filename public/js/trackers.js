// ===== Tracker state + actions =====
import { load, save } from './store.js';
import { fmtClock, toast } from './format.js';

export let state = load();
let onChange = null;
const persist = () => { save(state); onChange?.(state); };

/** Hook for server sync: called after every change. */
export const setOnChange = (fn) => { onChange = fn; };

/** Replace all trackers (e.g. with the synced server copy). */
export function replaceState(next) {
  state = next;
  save(state);
}
const find = (id) => state.find((t) => t.id === id);

export function addTracker(x) {
  state.unshift({ id: Date.now(), target: x, hits: [], roundsSince: 0, projection: null, scores: [] });
  persist();
}

export function logHit(id) {
  const tr = find(id); if (!tr) return;
  const now = Date.now();

  // Score an open prediction before recording the new hit
  if (tr.projection) {
    const pj = tr.projection;
    let ok, detail;
    if (pj.dueRounds && tr.roundsSince > 0) {
      const tol = Math.max(1, Math.round(pj.dueRounds * 0.2));
      ok = Math.abs(tr.roundsSince - pj.dueRounds) <= tol;
      detail = `predicted ${pj.dueRounds} rounds, actual ${tr.roundsSince}`;
    } else {
      ok = Math.abs(now - pj.dueTime) <= pj.interval * 0.2;
      detail = `predicted ${fmtClock(pj.dueTime)}, actual ${fmtClock(now)}`;
    }
    tr.scores.push({ ok, detail });
    toast(ok ? 'Prediction landed within the window' : 'Prediction missed');
    tr.projection = null;
  }

  tr.hits.push({ t: now, rounds: tr.hits.length ? tr.roundsSince : null });
  tr.roundsSince = 0;
  persist();
}

export function addRound(id) {
  const tr = find(id); if (!tr) return;
  tr.roundsSince++;
  persist();
}

export function calculate(id) {
  const tr = find(id); if (!tr || tr.hits.length < 2) return;
  const [a, b] = tr.hits.slice(-2);
  const interval = b.t - a.t;
  tr.projection = { interval, dueTime: b.t + interval, dueRounds: b.rounds || null, made: Date.now() };
  persist();
}

export function undoHit(id) {
  const tr = find(id); if (!tr || !tr.hits.length) return;
  tr.hits.pop();
  tr.projection = null;
  persist();
}

export function removeTracker(id) {
  state = state.filter((t) => t.id !== id);
  persist();
}
