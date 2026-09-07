// store.js — localStorage persistence: settings, calibration, practice history.
// Everything here is per-device and never leaves the browser.

const KEY = { settings: 'yf.settings', tuning: 'yf.tuning', history: 'yf.history' };
const read = (k, fallback) => {
  try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fallback; } catch { return fallback; }
};
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

// ---------- settings ----------
export const DEFAULT_SETTINGS = { voice: true, hold: 30, facing: 'user', model: 'lite', ghost: true, countdown: true };
export const settings = { ...DEFAULT_SETTINGS, ...read(KEY.settings, {}) };
export function saveSettings(patch = {}) {
  Object.assign(settings, patch);
  write(KEY.settings, settings);
}

// ---------- calibration ----------
// { [poseId]: { [checkId]: [lo, hi] } } — overrides the shipped target ranges.
const validRange = (r) => Array.isArray(r) && r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[0] <= r[1];
const asTuning = (v) => {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const [pose, ranges] of Object.entries(v)) {
    if (!ranges || typeof ranges !== 'object') continue;
    const keep = Object.fromEntries(Object.entries(ranges).filter(([, r]) => validRange(r)));
    if (Object.keys(keep).length) out[pose] = keep;
  }
  return out;
};
export const tuning = asTuning(read(KEY.tuning, {}));
export function tuningFor(poseId) { return tuning[poseId] || null; }
export function saveTuning(poseId, ranges) {
  const keep = Object.fromEntries(Object.entries(ranges).filter(([, r]) => validRange(r)));
  tuning[poseId] = { ...(tuning[poseId] || {}), ...keep };
  write(KEY.tuning, tuning);
}
export function clearTuning(poseId) {
  if (poseId) delete tuning[poseId]; else for (const k of Object.keys(tuning)) delete tuning[k];
  write(KEY.tuning, tuning);
}
export const isTuned = (poseId) => !!tuning[poseId];

// ---------- history ----------
// [{ ts, poseId, name, secs, score, side, reps, checks: { [id]: goodFraction } }]
const MAX_ENTRIES = 400;
// A well-formed JSON value of the wrong shape would otherwise crash summary() at
// module scope, leaving a home screen with no tiles and no way to clear the data.
const asArray = (v) => (Array.isArray(v) ? v.filter((r) => r && typeof r === 'object' && Number.isFinite(r.ts)) : []);
export const history = asArray(read(KEY.history, []));
export function addEntry(entry) {
  history.unshift({ ts: Date.now(), ...entry });
  if (history.length > MAX_ENTRIES) history.length = MAX_ENTRIES;
  write(KEY.history, history);
  return history[0];
}
export function clearHistory() { history.length = 0; write(KEY.history, history); }

const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

/** Consecutive days practised, counting back from today (or yesterday if today is empty). */
export function streak() {
  if (!history.length) return 0;
  const days = new Set(history.map((h) => dayKey(h.ts)));
  const d = new Date();
  if (!days.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (days.has(dayKey(d.getTime()))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

export function summary() {
  const weekAgo = Date.now() - 7 * 864e5;
  const week = history.filter((h) => h.ts >= weekAgo);
  return {
    streak: streak(),
    holdsThisWeek: week.length,
    secondsThisWeek: week.reduce((t, h) => t + (h.secs || 0), 0),
    total: history.length,
  };
}

/** Per-pose stats: attempts, best and recent score, and left/right balance. */
export function statsFor(poseId, side = null) {
  const rows = history.filter((h) => h.poseId === poseId && (!side || h.side === side));
  if (!rows.length) return null;
  const sides = { Left: 0, Right: 0 };
  for (const r of rows) if (r.side) sides[r.side]++;
  return {
    count: rows.length,
    best: Math.max(...rows.map((r) => (Number.isFinite(r.score) ? r.score : 0))),
    recent: rows[0].score,
    lastAt: rows[0].ts,
    sides,
    unbalanced: sides.Left + sides.Right >= 3 && Math.abs(sides.Left - sides.Right) >= 2,
  };
}

export function relativeTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}
