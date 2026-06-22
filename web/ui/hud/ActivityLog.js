/**
 * ActivityLog — High-quality brain activity log for UI v2
 * Shows live events coming from the BrainSystem in a clean, scrollable way.
 */

export function createActivityLog(container, brainSystem, options = {}) {
  const el = document.createElement('div');
  el.style.cssText = `
    position: absolute;
    top: 16px;
    left: 16px;
    width: 260px;
    max-height: 220px;
    background: rgba(10, 10, 18, 0.88);
    border: 1px solid rgba(120, 140, 255, 0.18);
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 11.5px;
    color: #c7d2fe;
    backdrop-filter: blur(8px);
    overflow-y: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    line-height: 1.35;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  `;

  const title = document.createElement('div');
  title.style.cssText = 'font-weight: 600; margin-bottom: 6px; opacity: 0.85; font-size: 10px; letter-spacing: 0.5px;';
  title.textContent = 'BRAIN ACTIVITY';
  el.appendChild(title);

  const logContainer = document.createElement('div');
  logContainer.style.cssText = 'max-height: 170px; overflow-y: auto;';
  el.appendChild(logContainer);

  container.appendChild(el);

  const entries = [];

  function addEntry(message, type = 'default') {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const row = document.createElement('div');
    row.style.cssText = `
      padding: 2px 0;
      border-bottom: 1px solid rgba(100, 120, 255, 0.08);
      display: flex;
      gap: 6px;
    `;

    const timeEl = document.createElement('span');
    timeEl.style.cssText = 'opacity: 0.45; flex-shrink: 0;';
    timeEl.textContent = time;

    const msgEl = document.createElement('span');
    msgEl.style.cssText = type === 'focus' ? 'color: #67e8f9;' : '';
    msgEl.textContent = message;

    row.appendChild(timeEl);
    row.appendChild(msgEl);
    logContainer.appendChild(row);

    entries.push(row);

    // Keep only last 18 entries
    while (entries.length > 18) {
      const old = entries.shift();
      old.remove();
    }

    // Auto scroll to bottom
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  let unsub = null;

  if (brainSystem) {
    // The BrainSystem publishes its activity as `snap.eventLog` — an array of
    // { t, msg } entries, newest first (see BrainSystem._logEvent). Each log
    // entry is a distinct object, so we dedup by object identity rather than by
    // timestamp: timestamps are millisecond-granular (Date.now) and two events
    // emitted in the same millisecond would otherwise collide and get dropped.
    let lastSeenEntry = null;

    unsub = brainSystem.subscribe((snap) => {
      const log = snap && Array.isArray(snap.eventLog) ? snap.eventLog : null;
      if (!log || log.length === 0) return;

      // eventLog is newest-first; collect entries up to (but not including) the
      // last one we've already rendered, then reverse so they append in
      // chronological order.
      const fresh = [];
      for (const entry of log) {
        if (entry === lastSeenEntry) break;
        if (!entry) continue;
        fresh.unshift(entry);
      }

      if (fresh.length === 0) return;
      lastSeenEntry = log[0];

      for (const entry of fresh) {
        const msg = entry.msg != null ? String(entry.msg) : '';
        const type = /focus/i.test(msg) ? 'focus' : 'default';
        addEntry(msg, type);
      }
    });
  }

  return {
    el,
    addEntry,
    destroy() {
      if (unsub) unsub();
      el.remove();
    }
  };
}
