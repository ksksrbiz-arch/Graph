// Saved connector config — localStorage persistence shared between
// connectors.js (card quick-run) and ingest-wizard.js (pre-fill + save).

function configKey(id) { return `graph:cc:${id}`; }

export function loadSavedConfig(id) {
  try { return JSON.parse(localStorage.getItem(configKey(id)) || '{}'); } catch (err) {
    console.warn('[connector-config] Failed to parse saved config for', id, err);
    return {};
  }
}

export function saveConfig(id, env) {
  try { localStorage.setItem(configKey(id), JSON.stringify(env)); } catch { /* storage quota */ }
}
