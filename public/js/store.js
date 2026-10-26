// ===== Local persistence (stays on the device) =====
const KEY = 'aviatortracker.v1';
const LEGACY_KEYS = ['gaptrack.v1'];

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) || [];
    for (const k of LEGACY_KEYS) {              // migrate data from earlier builds
      const old = localStorage.getItem(k);
      if (old) { localStorage.setItem(KEY, old); return JSON.parse(old) || []; }
    }
  } catch { /* storage unavailable or corrupt */ }
  return [];
}

export function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
}
