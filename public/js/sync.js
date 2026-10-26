// ===== Tracker sync for subscribers (local copy stays the offline cache) =====
import { api } from './api.js';

const DIRTY_KEY = 'aviatortracker.dirty';
const migratedKey = (uid) => `aviatortracker.migrated.${uid}`;

let enabled = false, timer = null, latest = null;

const flag = {
  get: (k) => { try { return localStorage.getItem(k) === '1'; } catch { return false; } },
  set: (k, on) => { try { on ? localStorage.setItem(k, '1') : localStorage.removeItem(k); } catch { /* ignore */ } },
};

async function push() {
  timer = null;
  if (!enabled || !latest) return;
  try {
    await api('/trackers', { method: 'PUT', body: { trackers: latest } });
    flag.set(DIRTY_KEY, false);
  } catch {
    /* offline or session lapsed: stays dirty and is pushed on the next change, reconnect or launch */
  }
}

/** Called after every local change. */
export function queuePush(state) {
  latest = state;
  if (!enabled) return;
  flag.set(DIRTY_KEY, true);
  clearTimeout(timer);
  timer = setTimeout(push, 800);
}

/**
 * Start syncing for an active subscriber. Returns the tracker list to use:
 * unsynced local edits and the first sign-in's existing local data are uploaded, otherwise the server copy wins.
 */
export async function startSync(local, userId) {
  enabled = true;
  latest = local;
  const { trackers: remote } = await api('/trackers');
  const firstSync = !flag.get(migratedKey(userId));
  flag.set(migratedKey(userId), true);
  if (flag.get(DIRTY_KEY) || (firstSync && !remote.length && local.length)) {
    await push();
    return local;
  }
  return remote;
}

export function stopSync() { enabled = false; clearTimeout(timer); }

addEventListener('online', () => { if (enabled && flag.get(DIRTY_KEY)) push(); });
