// Accounts Payable Cortex — Finance view.
//
// Mounted from web/app.js when the route hash is #/finance.
// Provides tabbed interface:
//   Queue     — pending bills + payment proposals awaiting approval
//   Bills     — all bills with status filter
//   Vendors   — vendor master list
//   Tax       — tax liabilities tracker
//   Ingest    — paste invoice text or upload image for AI extraction

let mounted = false;
let userId = 'local';
let apiBase = '';
let activeTab = 'queue';

// ── Public mount ───────────────────────────────────────────────────────

export function mount(rootEl, opts = {}) {
  if (mounted) return;
  mounted = true;
  userId  = (opts.userId  ?? window.GRAPH_CONFIG?.brainUserId ?? 'local').toString();
  apiBase = (opts.apiBase ?? window.GRAPH_CONFIG?.apiBaseUrl  ?? '').toString();

  rootEl.innerHTML = `
    <div class="view-header">
      <h2>Finance <span class="fin-badge">AP Cortex</span></h2>
      <p class="view-sub">Accounts Payable Cortex — approval queue, bills, vendors, and tax liabilities.</p>
    </div>
    <div class="fin-shell">
      <nav class="fin-tabs" role="tablist" aria-label="Finance tabs">
        <button type="button" class="fin-tab active" data-tab="queue"   role="tab">Queue</button>
        <button type="button" class="fin-tab"         data-tab="bills"   role="tab">Bills</button>
        <button type="button" class="fin-tab"         data-tab="vendors" role="tab">Vendors</button>
        <button type="button" class="fin-tab"         data-tab="tax"     role="tab">Tax</button>
        <button type="button" class="fin-tab"         data-tab="ingest"  role="tab">Ingest</button>
      </nav>
      <div class="fin-content" id="fin-content"></div>
    </div>
  `;

  injectStyles();

  rootEl.querySelectorAll('.fin-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  switchTab('queue');
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.fin-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
    b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false');
  });
  const content = document.getElementById('fin-content');
  if (!content) return;
  content.innerHTML = '<div class="fin-loading">Loading…</div>';
  const render = { queue: renderQueue, bills: renderBills, vendors: renderVendors, tax: renderTax, ingest: renderIngest };
  (render[tab] || renderQueue)(content);
}

// ── Queue tab ─────────────────────────────────────────────────────────

async function renderQueue(el) {
  let data;
  try {
    data = await apiFetch('/api/v1/finance/queue');
  } catch (err) {
    el.innerHTML = err_html(err.message); return;
  }

  const { bills = [], proposals = [] } = data;

  el.innerHTML = `
    <div class="fin-section">
      <h3 class="fin-section-title">Pending Bills <span class="fin-count">${bills.length}</span></h3>
      ${bills.length === 0 ? '<p class="fin-empty">No pending bills 🎉</p>' : `
        <table class="fin-table">
          <thead><tr><th>Vendor</th><th>Invoice #</th><th>Amount</th><th>Due</th><th>Risk</th><th>Tax</th><th>Actions</th></tr></thead>
          <tbody>
            ${bills.map((b) => `
              <tr data-id="${esc(b.id)}">
                <td>${esc(b.vendorName || '—')}</td>
                <td>${esc(b.invoiceNumber || '—')}</td>
                <td class="fin-amount">${cents(b.amountCents, b.currency)}</td>
                <td>${fmtDate(b.dueDate)}</td>
                <td>${riskBadge(b.riskScore)}</td>
                <td>${taxBadge(b.taxCategory)}</td>
                <td class="fin-actions">
                  <button class="fin-btn-approve" data-action="approve" data-type="bill" data-id="${esc(b.id)}">✓ Approve</button>
                  <button class="fin-btn-reject"  data-action="reject"  data-type="bill" data-id="${esc(b.id)}">✗ Reject</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>`}
    </div>
    <div class="fin-section">
      <h3 class="fin-section-title">Pending Payment Proposals <span class="fin-count">${proposals.length}</span></h3>
      ${proposals.length === 0 ? '<p class="fin-empty">No pending proposals 🎉</p>' : `
        <table class="fin-table">
          <thead><tr><th>Vendor</th><th>Invoice #</th><th>Amount</th><th>Pay Date</th><th>Method</th><th>Risk</th><th>Actions</th></tr></thead>
          <tbody>
            ${proposals.map((p) => `
              <tr data-id="${esc(p.id)}">
                <td>${esc(p.vendorName || '—')}</td>
                <td>${esc(p.invoiceNumber || '—')}</td>
                <td class="fin-amount">${cents(p.amountCents)}</td>
                <td>${fmtDate(p.proposedDate)}</td>
                <td><span class="fin-method">${esc(p.method)}</span></td>
                <td>${riskBadge(p.riskScore)}</td>
                <td class="fin-actions">
                  <button class="fin-btn-approve" data-action="approve" data-type="proposal" data-id="${esc(p.id)}">✓ Approve</button>
                  <button class="fin-btn-reject"  data-action="reject"  data-type="proposal" data-id="${esc(p.id)}">✗ Reject</button>
                </td>
              </tr>
              ${p.rationale ? `<tr class="fin-rationale-row"><td colspan="7"><span class="fin-rationale">💡 ${esc(p.rationale)}</span></td></tr>` : ''}`).join('')}
          </tbody>
        </table>`}
    </div>`;

  el.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => handleQueueAction(btn.dataset.type, btn.dataset.id, btn.dataset.action));
  });
}

async function handleQueueAction(type, id, action) {
  const mapped = action === 'approve' ? 'approved' : 'rejected';
  try {
    if (type === 'bill') {
      await apiFetch(`/api/v1/finance/bills/${id}/status`, 'PUT', { status: mapped });
    } else {
      await apiFetch(`/api/v1/finance/proposals/${id}/approve`, 'POST', { action: mapped });
    }
    showToast(`${type} ${mapped}`, 'success');
    // Refresh queue
    const content = document.getElementById('fin-content');
    if (content) { content.innerHTML = '<div class="fin-loading">Loading…</div>'; renderQueue(content); }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Bills tab ─────────────────────────────────────────────────────────

async function renderBills(el) {
  const status = el.dataset.status || '';
  let data;
  try {
    const qs = status ? `&status=${encodeURIComponent(status)}` : '';
    data = await apiFetch(`/api/v1/finance/bills?limit=100${qs}`);
  } catch (err) {
    el.innerHTML = err_html(err.message); return;
  }
  const bills = data.bills || [];
  el.innerHTML = `
    <div class="fin-toolbar">
      <label>Status:
        <select id="fin-bill-status">
          <option value="" ${!status ? 'selected' : ''}>All</option>
          ${['pending','approved','paid','rejected','overdue'].map((s) => `<option value="${s}" ${status===s?'selected':''}>${s}</option>`).join('')}
        </select>
      </label>
      <button type="button" id="fin-bill-add" class="fin-btn-primary">+ Add Bill</button>
    </div>
    <table class="fin-table">
      <thead><tr><th>Vendor</th><th>Invoice #</th><th>Amount</th><th>Due</th><th>Status</th><th>Tax</th><th>Source</th></tr></thead>
      <tbody>
        ${bills.length === 0 ? '<tr><td colspan="7" class="fin-empty">No bills found.</td></tr>' :
          bills.map((b) => `<tr>
            <td>${esc(b.vendorName || '—')}</td>
            <td>${esc(b.invoiceNumber || '—')}</td>
            <td class="fin-amount">${cents(b.amountCents, b.currency)}</td>
            <td>${fmtDate(b.dueDate)}</td>
            <td><span class="fin-status fin-status-${esc(b.status)}">${esc(b.status)}</span></td>
            <td>${taxBadge(b.taxCategory)}</td>
            <td><span class="fin-source">${esc(b.source)}</span></td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  el.querySelector('#fin-bill-status')?.addEventListener('change', (e) => {
    el.dataset.status = e.target.value;
    el.innerHTML = '<div class="fin-loading">Loading…</div>';
    renderBills(el);
  });
  el.querySelector('#fin-bill-add')?.addEventListener('click', () => showAddBillModal());
}

// ── Vendors tab ───────────────────────────────────────────────────────

async function renderVendors(el) {
  let data;
  try {
    data = await apiFetch('/api/v1/finance/vendors?limit=100');
  } catch (err) {
    el.innerHTML = err_html(err.message); return;
  }
  const vendors = data.vendors || [];
  el.innerHTML = `
    <div class="fin-toolbar">
      <button type="button" id="fin-vendor-add" class="fin-btn-primary">+ Add Vendor</button>
    </div>
    <table class="fin-table">
      <thead><tr><th>Name</th><th>EIN</th><th>Terms</th><th>Early-pay discount</th><th>Contact</th><th>Status</th></tr></thead>
      <tbody>
        ${vendors.length === 0 ? '<tr><td colspan="6" class="fin-empty">No vendors yet.</td></tr>' :
          vendors.map((v) => `<tr>
            <td>${esc(v.name)}</td>
            <td>${esc(v.ein || '—')}</td>
            <td>Net-${v.paymentTerms}</td>
            <td>${v.earlyPayDiscountPct > 0 ? `${(v.earlyPayDiscountPct * 100).toFixed(1)}% / ${v.earlyPayDiscountDays}d` : '—'}</td>
            <td>${esc(v.contactEmail || '—')}</td>
            <td><span class="fin-status fin-status-${esc(v.status)}">${esc(v.status)}</span></td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  el.querySelector('#fin-vendor-add')?.addEventListener('click', () => showAddVendorModal());
}

// ── Tax tab ───────────────────────────────────────────────────────────

async function renderTax(el) {
  let data;
  try {
    data = await apiFetch('/api/v1/finance/tax?limit=50');
  } catch (err) {
    el.innerHTML = err_html(err.message); return;
  }
  const liabilities = data.liabilities || [];
  el.innerHTML = `
    <div class="fin-toolbar">
      <button type="button" id="fin-tax-add" class="fin-btn-primary">+ Add Liability</button>
    </div>
    <p class="fin-hint">WA B&amp;O, WA Retail Sales Tax (expanded 2025–2026), and Federal obligations. Proposals only — consult your CPA before filing.</p>
    <table class="fin-table">
      <thead><tr><th>Type</th><th>Period</th><th>Estimated</th><th>Filed</th><th>Due</th><th>Status</th></tr></thead>
      <tbody>
        ${liabilities.length === 0 ? '<tr><td colspan="6" class="fin-empty">No tax liabilities recorded.</td></tr>' :
          liabilities.map((t) => `<tr>
            <td><span class="fin-tax-type">${esc(t.taxType)}</span></td>
            <td>${esc(t.period)}</td>
            <td class="fin-amount">${cents(t.estimatedCents)}</td>
            <td class="fin-amount">${t.filedCents != null ? cents(t.filedCents) : '—'}</td>
            <td>${fmtDate(t.dueDate)}</td>
            <td><span class="fin-status fin-status-${esc(t.status)}">${esc(t.status)}</span></td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  el.querySelector('#fin-tax-add')?.addEventListener('click', () => showAddTaxModal());
}

// ── Ingest tab ────────────────────────────────────────────────────────

function renderIngest(el) {
  el.innerHTML = `
    <div class="fin-ingest">
      <h3 class="fin-section-title">Ingest Invoice</h3>
      <p class="fin-hint">Paste raw invoice text below (or upload an image) and the AI will extract structured data and create a bill for review.</p>
      <div class="fin-ingest-modes">
        <label><input type="radio" name="ingest-mode" value="text" checked /> Text / Paste</label>
        <label><input type="radio" name="ingest-mode" value="image" /> Image upload</label>
      </div>
      <div id="fin-ingest-text-block">
        <textarea id="fin-invoice-text" rows="10" placeholder="Paste invoice text here…"></textarea>
      </div>
      <div id="fin-ingest-image-block" style="display:none">
        <input type="file" id="fin-invoice-image" accept="image/*" />
        <p class="fin-hint">Supports JPEG, PNG, WEBP. The image will be sent to LLaVA for OCR.</p>
      </div>
      <button type="button" id="fin-ingest-submit" class="fin-btn-primary">Extract &amp; Create Bill</button>
      <div id="fin-ingest-result"></div>
    </div>`;

  el.querySelectorAll('input[name="ingest-mode"]').forEach((r) => {
    r.addEventListener('change', () => {
      el.querySelector('#fin-ingest-text-block').style.display = r.value === 'text' ? '' : 'none';
      el.querySelector('#fin-ingest-image-block').style.display = r.value === 'image' ? '' : 'none';
    });
  });

  el.querySelector('#fin-ingest-submit')?.addEventListener('click', () => onIngestSubmit(el));
}

async function onIngestSubmit(el) {
  const mode = el.querySelector('input[name="ingest-mode"]:checked')?.value || 'text';
  const resultEl = el.querySelector('#fin-ingest-result');
  const btn = el.querySelector('#fin-ingest-submit');
  btn.disabled = true;
  resultEl.innerHTML = '<p class="fin-loading">Extracting invoice data…</p>';

  let body;
  try {
    if (mode === 'text') {
      const text = (el.querySelector('#fin-invoice-text')?.value || '').trim();
      if (!text) { resultEl.innerHTML = err_html('Please paste some invoice text.'); btn.disabled = false; return; }
      body = { text };
    } else {
      const file = el.querySelector('#fin-invoice-image')?.files?.[0];
      if (!file) { resultEl.innerHTML = err_html('Please select an image file.'); btn.disabled = false; return; }
      const b64 = await fileToBase64(file);
      body = { image: b64 };
    }

    const result = await apiFetch('/api/v1/finance/bills/ingest', 'POST', body);
    const x = result.extracted || {};
    resultEl.innerHTML = `
      <div class="fin-ingest-ok">
        <p>✅ Bill created — <strong>ID ${esc(result.id)}</strong></p>
        <table class="fin-table">
          <tr><th>Vendor</th><td>${esc(x.vendorName || '—')}</td></tr>
          <tr><th>Invoice #</th><td>${esc(x.invoiceNumber || '—')}</td></tr>
          <tr><th>Amount</th><td>${cents(x.amountCents)}</td></tr>
          <tr><th>Due Date</th><td>${fmtDate(x.dueDate)}</td></tr>
          <tr><th>Tax Category</th><td>${taxBadge(x.taxCategory)}</td></tr>
          <tr><th>Description</th><td>${esc(x.description || '—')}</td></tr>
        </table>
        <p class="fin-hint">The bill is now in the approval queue. Switch to <em>Queue</em> to approve or reject.</p>
      </div>`;
  } catch (err) {
    resultEl.innerHTML = err_html(err.message);
  } finally {
    btn.disabled = false;
  }
}

// ── Add Modals ────────────────────────────────────────────────────────

function showAddVendorModal() {
  const overlay = modal(`
    <h3>Add Vendor</h3>
    <form id="add-vendor-form">
      <label>Name* <input name="name" required /></label>
      <label>EIN <input name="ein" placeholder="12-3456789" /></label>
      <label>Payment Terms (days) <input name="paymentTerms" type="number" value="30" min="0" /></label>
      <label>Early-pay discount % <input name="earlyPayDiscountPct" type="number" value="0" min="0" max="100" step="0.1" /></label>
      <label>Early-pay discount days <input name="earlyPayDiscountDays" type="number" value="0" min="0" /></label>
      <label>Contact Email <input name="contactEmail" type="email" /></label>
      <label>Notes <textarea name="notes" rows="2"></textarea></label>
      <div class="modal-actions">
        <button type="submit" class="fin-btn-primary">Create</button>
        <button type="button" class="modal-cancel">Cancel</button>
      </div>
    </form>`);

  overlay.querySelector('#add-vendor-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const vendor = {
      name: fd.get('name'),
      ein: fd.get('ein') || undefined,
      paymentTerms: parseInt(fd.get('paymentTerms'), 10) || 30,
      earlyPayDiscountPct: (parseFloat(fd.get('earlyPayDiscountPct')) || 0) / 100,
      earlyPayDiscountDays: parseInt(fd.get('earlyPayDiscountDays'), 10) || 0,
      contactEmail: fd.get('contactEmail') || undefined,
      notes: fd.get('notes') || undefined,
    };
    try {
      await apiFetch('/api/v1/finance/vendors', 'POST', { vendor });
      closeModal(overlay);
      showToast('Vendor created', 'success');
      const content = document.getElementById('fin-content');
      if (content) { content.innerHTML = '<div class="fin-loading">Loading…</div>'; renderVendors(content); }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
  overlay.querySelector('.modal-cancel')?.addEventListener('click', () => closeModal(overlay));
}

function showAddBillModal() {
  const overlay = modal(`
    <h3>Add Bill</h3>
    <form id="add-bill-form">
      <label>Vendor ID or Name <input name="vendorName" placeholder="Vendor name (will auto-create)" /></label>
      <label>Invoice # <input name="invoiceNumber" /></label>
      <label>Amount (USD) <input name="amount" type="number" step="0.01" min="0" required /></label>
      <label>Invoice Date <input name="invoiceDate" type="date" /></label>
      <label>Due Date <input name="dueDate" type="date" /></label>
      <label>Tax Category
        <select name="taxCategory">
          <option value="">None</option>
          <option value="WA_BO">WA B&amp;O</option>
          <option value="WA_SALES_TAX">WA Sales Tax</option>
          <option value="FEDERAL_1099">Federal 1099</option>
        </select>
      </label>
      <label>Description <textarea name="description" rows="2"></textarea></label>
      <div class="modal-actions">
        <button type="submit" class="fin-btn-primary">Create</button>
        <button type="button" class="modal-cancel">Cancel</button>
      </div>
    </form>`);

  overlay.querySelector('#add-bill-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const amountCents = Math.round((parseFloat(fd.get('amount')) || 0) * 100);
    const bill = {
      vendorName: fd.get('vendorName') || undefined,
      invoiceNumber: fd.get('invoiceNumber') || undefined,
      amountCents,
      invoiceDate: fd.get('invoiceDate') ? new Date(fd.get('invoiceDate')).getTime() : undefined,
      dueDate: fd.get('dueDate') ? new Date(fd.get('dueDate')).getTime() : undefined,
      taxCategory: fd.get('taxCategory') || undefined,
      description: fd.get('description') || undefined,
      source: 'manual',
    };
    try {
      await apiFetch('/api/v1/finance/bills', 'POST', { bill });
      closeModal(overlay);
      showToast('Bill created', 'success');
      const content = document.getElementById('fin-content');
      if (content) { content.innerHTML = '<div class="fin-loading">Loading…</div>'; renderBills(content); }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
  overlay.querySelector('.modal-cancel')?.addEventListener('click', () => closeModal(overlay));
}

function showAddTaxModal() {
  const overlay = modal(`
    <h3>Add Tax Liability</h3>
    <form id="add-tax-form">
      <label>Type
        <select name="taxType" required>
          <option value="WA_BO">WA B&amp;O</option>
          <option value="WA_SALES_TAX">WA Sales Tax</option>
          <option value="FEDERAL_1099">Federal 1099</option>
          <option value="FEDERAL_QUARTERLY">Federal Quarterly</option>
        </select>
      </label>
      <label>Period (e.g. 2025-Q2) <input name="period" required placeholder="2025-Q2" /></label>
      <label>Estimated Amount (USD) <input name="amount" type="number" step="0.01" min="0" required /></label>
      <label>Due Date <input name="dueDate" type="date" /></label>
      <label>Notes <textarea name="notes" rows="2"></textarea></label>
      <div class="modal-actions">
        <button type="submit" class="fin-btn-primary">Save</button>
        <button type="button" class="modal-cancel">Cancel</button>
      </div>
    </form>`);

  overlay.querySelector('#add-tax-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const liability = {
      taxType: fd.get('taxType'),
      period: fd.get('period'),
      estimatedCents: Math.round((parseFloat(fd.get('amount')) || 0) * 100),
      dueDate: fd.get('dueDate') ? new Date(fd.get('dueDate')).getTime() : undefined,
      notes: fd.get('notes') || undefined,
    };
    try {
      await apiFetch('/api/v1/finance/tax', 'POST', { liability });
      closeModal(overlay);
      showToast('Tax liability saved', 'success');
      const content = document.getElementById('fin-content');
      if (content) { content.innerHTML = '<div class="fin-loading">Loading…</div>'; renderTax(content); }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
  overlay.querySelector('.modal-cancel')?.addEventListener('click', () => closeModal(overlay));
}

// ── API helpers ───────────────────────────────────────────────────────

async function apiFetch(path, method = 'GET', body) {
  const fullPath = apiBase ? new URL(path, apiBase).toString() : path;
  const sep = fullPath.includes('?') ? '&' : '?';
  // Always include userId in the query string so the router can read it
  // without consuming the request body.
  const url = `${fullPath}${sep}userId=${encodeURIComponent(userId)}`;
  const opts = {
    method,
    headers: { 'content-type': 'application/json' },
  };
  if (body) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── UI helpers ────────────────────────────────────────────────────────

function modal(innerHTML) {
  const overlay = document.createElement('div');
  overlay.className = 'fin-modal-overlay';
  overlay.innerHTML = `<div class="fin-modal">${innerHTML}</div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(overlay); });
  return overlay;
}
function closeModal(overlay) { overlay.remove(); }

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = `toast toast-${type}`;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3000);
}

function cents(c, currency = 'USD') {
  if (c == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(c / 100);
}

function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const now = Date.now();
  const overdue = ms < now;
  const s = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return overdue ? `<span class="fin-overdue">${s}</span>` : s;
}

function riskBadge(score) {
  if (score == null) return '—';
  const pct = Math.round(score * 100);
  const cls = pct >= 70 ? 'high' : pct >= 40 ? 'med' : 'low';
  return `<span class="fin-risk fin-risk-${cls}">${pct}%</span>`;
}

function taxBadge(cat) {
  if (!cat || cat === 'NONE') return '<span class="fin-tax-badge none">None</span>';
  return `<span class="fin-tax-badge ${cat.toLowerCase().replace(/_/g, '-')}">${esc(cat)}</span>`;
}

function err_html(msg) {
  return `<div class="fin-error">⚠ ${esc(msg)}</div>`;
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const comma = reader.result.indexOf(',');
      resolve(comma >= 0 ? reader.result.slice(comma + 1) : reader.result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ── Styles ────────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('fin-styles')) return;
  const style = document.createElement('style');
  style.id = 'fin-styles';
  style.textContent = `
    .fin-badge { font-size: 10px; background: #1d3a5e; color: #9bd1ff; padding: 2px 7px; border-radius: 4px; vertical-align: middle; margin-left: 6px; text-transform: uppercase; letter-spacing: 0.05em; }
    .fin-shell { display: flex; flex-direction: column; height: 100%; padding: 0 16px 16px; gap: 0; }
    .fin-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border, #232836); padding-bottom: 0; margin-bottom: 0; }
    .fin-tab { background: none; border: none; border-bottom: 2px solid transparent; color: var(--text-dim, #9aa3b2); padding: 8px 14px; border-radius: 0; cursor: pointer; font: 13px/1 system-ui; }
    .fin-tab:hover { color: var(--text, #e6e8ee); }
    .fin-tab.active { color: var(--accent, #7c9cff); border-bottom-color: var(--accent, #7c9cff); }
    .fin-content { flex: 1; overflow: auto; padding-top: 12px; }
    .fin-loading { color: var(--text-dim, #9aa3b2); padding: 20px; }
    .fin-error { color: #ff8a8a; padding: 10px; background: #3a1a1a; border-radius: 6px; margin: 8px 0; }
    .fin-empty { color: var(--text-faint, #6b7385); font-style: italic; padding: 12px 0; }
    .fin-section { margin-bottom: 24px; }
    .fin-section-title { font: 600 12px/1 ui-monospace, monospace; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim, #9aa3b2); margin: 0 0 10px; }
    .fin-section-title .fin-count { background: var(--bg-elev-2, #181c25); color: var(--text, #e6e8ee); padding: 1px 6px; border-radius: 10px; font-weight: 400; margin-left: 4px; }
    .fin-toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
    .fin-toolbar label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-dim, #9aa3b2); }
    .fin-toolbar select { background: var(--bg-elev-2, #181c25); color: var(--text, #e6e8ee); border: 1px solid var(--border, #232836); border-radius: 5px; padding: 4px 8px; font: 13px system-ui; }
    .fin-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .fin-table th { text-align: left; padding: 6px 10px; font: 600 11px/1 ui-monospace, monospace; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim, #9aa3b2); border-bottom: 1px solid var(--border, #232836); white-space: nowrap; }
    .fin-table td { padding: 8px 10px; border-bottom: 1px solid #1a1f2c; vertical-align: middle; color: var(--text, #e6e8ee); }
    .fin-table tr:last-child td { border-bottom: none; }
    .fin-table tr:hover td { background: #11141b; }
    .fin-amount { font-family: ui-monospace, monospace; font-variant-numeric: tabular-nums; }
    .fin-overdue { color: #ff8a8a; }
    .fin-status { display: inline-block; padding: 1px 7px; border-radius: 4px; font-size: 11px; text-transform: uppercase; font-weight: 600; letter-spacing: 0.04em; }
    .fin-status-pending  { background: #2a2d1a; color: #e0d278; }
    .fin-status-approved { background: #1a2d1a; color: #5fd0a4; }
    .fin-status-paid     { background: #1a2a1a; color: #34d399; }
    .fin-status-rejected { background: #2d1a1a; color: #ff8a8a; }
    .fin-status-overdue  { background: #3a1a1a; color: #ff6b6b; }
    .fin-status-estimated{ background: #1a2237; color: #9bd1ff; }
    .fin-status-filed    { background: #1a2a2a; color: #5fd0a4; }
    .fin-risk { display: inline-block; padding: 1px 6px; border-radius: 3px; font: 600 11px/1.5 ui-monospace, monospace; }
    .fin-risk-low  { background: #1a2d1a; color: #5fd0a4; }
    .fin-risk-med  { background: #2a2d1a; color: #e0d278; }
    .fin-risk-high { background: #3a1a1a; color: #ff8a8a; }
    .fin-method { font: 11px ui-monospace, monospace; color: var(--text-dim, #9aa3b2); }
    .fin-source { font: 11px ui-monospace, monospace; color: var(--text-faint, #6b7385); }
    .fin-tax-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10.5px; font-weight: 600; letter-spacing: 0.03em; }
    .fin-tax-badge.none     { background: #1a1f2c; color: var(--text-faint, #6b7385); }
    .fin-tax-badge.wa-bo    { background: #1d2d1a; color: #7ee787; }
    .fin-tax-badge.wa-sales-tax { background: #1d2a1a; color: #5fd0a4; }
    .fin-tax-badge.federal-1099 { background: #2a1d3a; color: #cfb1ff; }
    .fin-tax-type { font: 600 11px/1.5 ui-monospace, monospace; color: var(--accent, #7c9cff); }
    .fin-actions { display: flex; gap: 4px; }
    .fin-btn-approve { background: #1f4d33; border: 1px solid #2a6b44; color: #a3f7c2; padding: 3px 9px; border-radius: 4px; font: 12px system-ui; cursor: pointer; }
    .fin-btn-approve:hover { background: #28633f; }
    .fin-btn-reject  { background: #3a1a1a; border: 1px solid #5a2a2a; color: #ff8a8a; padding: 3px 9px; border-radius: 4px; font: 12px system-ui; cursor: pointer; }
    .fin-btn-reject:hover { background: #4a2020; }
    .fin-btn-primary { background: linear-gradient(180deg, #2a3a78, #1f2c5f); border: 1px solid #3b4f9d; color: #fff; padding: 5px 12px; border-radius: 6px; font: 12px system-ui; cursor: pointer; }
    .fin-btn-primary:hover { border-color: var(--accent, #7c9cff); }
    .fin-btn-primary:disabled { opacity: 0.5; cursor: wait; }
    .fin-rationale-row td { padding: 0 10px 8px; }
    .fin-rationale { font-size: 12px; color: var(--text-dim, #9aa3b2); font-style: italic; }
    .fin-hint { font-size: 12px; color: var(--text-faint, #6b7385); margin: 0 0 10px; }
    .fin-ingest { max-width: 600px; }
    .fin-ingest-modes { display: flex; gap: 16px; margin-bottom: 10px; font-size: 13px; }
    .fin-ingest-modes label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
    #fin-invoice-text { width: 100%; background: #0a1322; color: #e6eef9; border: 1px solid #1d2b44; border-radius: 8px; padding: 10px; font: 12px/1.5 ui-monospace, monospace; resize: vertical; margin-bottom: 10px; }
    #fin-invoice-image { margin-bottom: 10px; }
    .fin-ingest-ok { margin-top: 12px; background: #0d1f17; border: 1px solid #1f4d33; border-radius: 8px; padding: 12px; }
    .fin-ingest-ok p { margin: 0 0 8px; color: #a3f7c2; font-size: 13px; }
    .fin-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.65); display: flex; align-items: center; justify-content: center; z-index: 1000; }
    .fin-modal { background: #11141b; border: 1px solid #232836; border-radius: 10px; padding: 24px; min-width: 360px; max-width: 480px; width: 100%; max-height: 90vh; overflow: auto; }
    .fin-modal h3 { margin: 0 0 16px; font-size: 15px; }
    .fin-modal label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-dim, #9aa3b2); margin-bottom: 10px; }
    .fin-modal input, .fin-modal select, .fin-modal textarea { background: #0a1322; color: #e6eef9; border: 1px solid #1d2b44; border-radius: 6px; padding: 7px 10px; font: 13px system-ui; width: 100%; }
    .fin-modal textarea { resize: vertical; }
    .modal-actions { display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end; }
  `;
  document.head.appendChild(style);
}
