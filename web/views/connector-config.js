// Saved connector config — localStorage persistence shared between
// connectors.js (card quick-run) and ingest-wizard.js (pre-fill + save).

function configKey(id) { return `graph:cc:${id}`; }
const SCHEDULE_KEY_PREFIX = 'graph:cs:';

export function loadSavedConfig(id) {
  try { return JSON.parse(localStorage.getItem(configKey(id)) || '{}'); } catch (err) {
    console.warn('[connector-config] Failed to parse saved config for', id, err);
    return {};
  }
}

export function saveConfig(id, env) {
  try { localStorage.setItem(configKey(id), JSON.stringify(env)); } catch { /* storage quota */ }
}

// ── Per-connector auto-run schedule ──────────────────────────────────────────

/** Available auto-run intervals shown in the schedule picker. */
export const SCHEDULE_OPTIONS = [
  { label: 'Off',          ms: 0 },
  { label: 'Every 15 min', ms: 15 * 60 * 1000 },
  { label: 'Every hour',   ms: 60 * 60 * 1000 },
  { label: 'Every 6 h',    ms: 6 * 60 * 60 * 1000 },
  { label: 'Every day',    ms: 24 * 60 * 60 * 1000 },
];

/**
 * Load the saved auto-run schedule for a connector.
 * Returns an object like `{ intervalMs: 3600000 }`, or `{}` when none is set.
 */
export function loadSchedule(id) {
  try {
    return JSON.parse(localStorage.getItem(`${SCHEDULE_KEY_PREFIX}${id}`) || 'null') || {};
  } catch (err) {
    console.warn('[connector-config] Failed to parse schedule for', id, err);
    return {};
  }
}

/** Persist the auto-run schedule for a connector. */
export function saveSchedule(id, cfg) {
  try { localStorage.setItem(`${SCHEDULE_KEY_PREFIX}${id}`, JSON.stringify(cfg)); }
  catch { /* storage quota */ }
}
