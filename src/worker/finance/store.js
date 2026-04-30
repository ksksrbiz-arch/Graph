// Accounts Payable Cortex — D1 persistence layer.
//
// All helpers accept a `db` (D1 binding) and return plain objects.
// Amounts are stored as integer cents to avoid floating-point drift.

const PAGE_MAX = 200;

// ── Vendors ───────────────────────────────────────────────────────────

export async function createVendor(db, { userId, vendor }) {
  if (!db) throw new Error('GRAPH_DB binding missing');
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.prepare(
    `INSERT INTO apc_vendors
       (id, user_id, name, ein, payment_terms, early_pay_discount_pct,
        early_pay_discount_days, contact_email, contact_phone,
        address_json, notes, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, userId,
    str(vendor.name, 200),
    str(vendor.ein, 20) ?? null,
    posInt(vendor.paymentTerms, 30),
    clampFloat(vendor.earlyPayDiscountPct, 0, 1, 0),
    posInt(vendor.earlyPayDiscountDays, 0),
    str(vendor.contactEmail, 200) ?? null,
    str(vendor.contactPhone, 40) ?? null,
    JSON.stringify(vendor.address ?? {}),
    str(vendor.notes, 2000) ?? null,
    'active', now, now,
  ).run();
  return { id, createdAt: now };
}

export async function listVendors(db, { userId, status, limit, offset }) {
  if (!db) return [];
  const lim = clampInt(limit, 1, PAGE_MAX, 50);
  const off = Math.max(0, offset | 0);
  const where = ['user_id = ?'];
  const params = [userId];
  if (status) { where.push('status = ?'); params.push(status); }
  const sql = `SELECT id, name, ein, payment_terms, early_pay_discount_pct,
                      early_pay_discount_days, contact_email, status,
                      created_at, updated_at
               FROM apc_vendors WHERE ${where.join(' AND ')}
               ORDER BY name ASC LIMIT ${lim} OFFSET ${off}`;
  const { results } = await db.prepare(sql).bind(...params).all();
  return (results || []).map(camelVendor);
}

export async function getVendor(db, { userId, vendorId }) {
  if (!db) return null;
  const row = await db
    .prepare(`SELECT * FROM apc_vendors WHERE user_id = ? AND id = ? LIMIT 1`)
    .bind(userId, vendorId).first();
  return row ? camelVendor(row) : null;
}

export async function updateVendor(db, { userId, vendorId, patch }) {
  if (!db) throw new Error('GRAPH_DB binding missing');
  const now = Date.now();
  const sets = ['updated_at = ?'];
  const params = [now];
  const map = {
    name: (v) => { sets.push('name = ?'); params.push(str(v, 200)); },
    ein: (v) => { sets.push('ein = ?'); params.push(str(v, 20) ?? null); },
    paymentTerms: (v) => { sets.push('payment_terms = ?'); params.push(posInt(v, 30)); },
    earlyPayDiscountPct: (v) => { sets.push('early_pay_discount_pct = ?'); params.push(clampFloat(v, 0, 1, 0)); },
    earlyPayDiscountDays: (v) => { sets.push('early_pay_discount_days = ?'); params.push(posInt(v, 0)); },
    contactEmail: (v) => { sets.push('contact_email = ?'); params.push(str(v, 200) ?? null); },
    contactPhone: (v) => { sets.push('contact_phone = ?'); params.push(str(v, 40) ?? null); },
    notes: (v) => { sets.push('notes = ?'); params.push(str(v, 2000) ?? null); },
    status: (v) => { if (v === 'active' || v === 'inactive') { sets.push('status = ?'); params.push(v); } },
  };
  for (const [k, fn] of Object.entries(map)) { if (k in patch) fn(patch[k]); }
  params.push(userId, vendorId);
  await db.prepare(`UPDATE apc_vendors SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`)
    .bind(...params).run();
  return { updatedAt: now };
}

// ── Bills ─────────────────────────────────────────────────────────────

export async function createBill(db, { userId, bill }) {
  if (!db) throw new Error('GRAPH_DB binding missing');
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.prepare(
    `INSERT INTO apc_bills
       (id, user_id, vendor_id, invoice_number, invoice_date, due_date,
        amount_cents, currency, tax_category, description, status, risk_score,
        source, raw_text, data_json, node_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, userId,
    str(bill.vendorId, 36) ?? null,
    str(bill.invoiceNumber, 100) ?? null,
    bill.invoiceDate ? Number(bill.invoiceDate) : null,
    bill.dueDate ? Number(bill.dueDate) : null,
    posInt(bill.amountCents, 0),
    str(bill.currency, 3) ?? 'USD',
    str(bill.taxCategory, 40) ?? null,
    str(bill.description, 1000) ?? null,
    'pending',
    clampFloat(bill.riskScore, 0, 1, 0),
    str(bill.source, 40) ?? 'manual',
    bill.rawText ? str(bill.rawText, 20_000) : null,
    JSON.stringify(bill.data ?? {}),
    str(bill.nodeId, 36) ?? null,
    now, now,
  ).run();
  return { id, createdAt: now };
}

export async function listBills(db, { userId, status, vendorId, limit, offset }) {
  if (!db) return [];
  const lim = clampInt(limit, 1, PAGE_MAX, 50);
  const off = Math.max(0, offset | 0);
  const where = ['b.user_id = ?'];
  const params = [userId];
  if (status) { where.push('b.status = ?'); params.push(status); }
  if (vendorId) { where.push('b.vendor_id = ?'); params.push(vendorId); }
  const sql = `SELECT b.id, b.vendor_id, b.invoice_number, b.invoice_date,
                      b.due_date, b.amount_cents, b.currency, b.tax_category,
                      b.description, b.status, b.risk_score, b.source,
                      b.created_at, b.updated_at, v.name AS vendor_name
               FROM apc_bills b
               LEFT JOIN apc_vendors v ON v.user_id = b.user_id AND v.id = b.vendor_id
               WHERE ${where.join(' AND ')}
               ORDER BY b.due_date ASC NULLS LAST, b.created_at DESC
               LIMIT ${lim} OFFSET ${off}`;
  const { results } = await db.prepare(sql).bind(...params).all();
  return (results || []).map(camelBill);
}

export async function getBill(db, { userId, billId }) {
  if (!db) return null;
  const sql = `SELECT b.*, v.name AS vendor_name
               FROM apc_bills b
               LEFT JOIN apc_vendors v ON v.user_id = b.user_id AND v.id = b.vendor_id
               WHERE b.user_id = ? AND b.id = ? LIMIT 1`;
  const row = await db.prepare(sql).bind(userId, billId).first();
  return row ? camelBill(row) : null;
}

export async function updateBillStatus(db, { userId, billId, status }) {
  if (!db) throw new Error('GRAPH_DB binding missing');
  const valid = ['pending', 'approved', 'paid', 'rejected', 'overdue'];
  if (!valid.includes(status)) throw new Error(`invalid status: ${status}`);
  const now = Date.now();
  await db.prepare(`UPDATE apc_bills SET status = ?, updated_at = ? WHERE user_id = ? AND id = ?`)
    .bind(status, now, userId, billId).run();
  return { updatedAt: now };
}

// ── Payment Proposals ─────────────────────────────────────────────────

export async function createProposal(db, { userId, proposal }) {
  if (!db) throw new Error('GRAPH_DB binding missing');
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.prepare(
    `INSERT INTO apc_payment_proposals
       (id, user_id, bill_id, proposed_date, amount_cents, method,
        rationale, risk_score, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, userId,
    str(proposal.billId, 36),
    Number(proposal.proposedDate),
    posInt(proposal.amountCents, 0),
    str(proposal.method, 20) ?? 'ach',
    str(proposal.rationale, 2000) ?? null,
    clampFloat(proposal.riskScore, 0, 1, 0),
    'pending', now, now,
  ).run();
  return { id, createdAt: now };
}

export async function listProposals(db, { userId, status, limit, offset }) {
  if (!db) return [];
  const lim = clampInt(limit, 1, PAGE_MAX, 50);
  const off = Math.max(0, offset | 0);
  const where = ['p.user_id = ?'];
  const params = [userId];
  if (status) { where.push('p.status = ?'); params.push(status); }
  const sql = `SELECT p.*, b.invoice_number, b.description AS bill_description,
                      v.name AS vendor_name
               FROM apc_payment_proposals p
               LEFT JOIN apc_bills b ON b.user_id = p.user_id AND b.id = p.bill_id
               LEFT JOIN apc_vendors v ON v.user_id = p.user_id AND v.id = b.vendor_id
               WHERE ${where.join(' AND ')}
               ORDER BY p.proposed_date ASC, p.created_at DESC
               LIMIT ${lim} OFFSET ${off}`;
  const { results } = await db.prepare(sql).bind(...params).all();
  return (results || []).map(camelProposal);
}

export async function approveProposal(db, { userId, proposalId, action, notes }) {
  if (!db) throw new Error('GRAPH_DB binding missing');
  const valid = ['approved', 'rejected'];
  if (!valid.includes(action)) throw new Error(`action must be approved or rejected`);
  const now = Date.now();
  await db.prepare(
    `UPDATE apc_payment_proposals
     SET status = ?, approved_at = ?, updated_at = ?
     WHERE user_id = ? AND id = ?`
  ).bind(action, now, now, userId, proposalId).run();
  return { updatedAt: now };
}

// ── Tax Liabilities ───────────────────────────────────────────────────

export async function upsertTaxLiability(db, { userId, liability }) {
  if (!db) throw new Error('GRAPH_DB binding missing');
  const now = Date.now();
  const existing = await db.prepare(
    `SELECT id FROM apc_tax_liabilities WHERE user_id = ? AND tax_type = ? AND period = ? LIMIT 1`
  ).bind(userId, liability.taxType, liability.period).first();
  if (existing) {
    await db.prepare(
      `UPDATE apc_tax_liabilities
       SET estimated_cents = ?, due_date = ?, notes = ?, updated_at = ?
       WHERE user_id = ? AND id = ?`
    ).bind(
      posInt(liability.estimatedCents, 0),
      liability.dueDate ? Number(liability.dueDate) : null,
      str(liability.notes, 2000) ?? null,
      now, userId, existing.id,
    ).run();
    return { id: existing.id, updatedAt: now, upserted: 'updated' };
  }
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO apc_tax_liabilities
       (id, user_id, tax_type, period, estimated_cents, due_date, status, notes, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, userId,
    str(liability.taxType, 40),
    str(liability.period, 20),
    posInt(liability.estimatedCents, 0),
    liability.dueDate ? Number(liability.dueDate) : null,
    'estimated',
    str(liability.notes, 2000) ?? null,
    now, now,
  ).run();
  return { id, createdAt: now, upserted: 'created' };
}

export async function listTaxLiabilities(db, { userId, status, limit, offset }) {
  if (!db) return [];
  const lim = clampInt(limit, 1, PAGE_MAX, 50);
  const off = Math.max(0, offset | 0);
  const where = ['user_id = ?'];
  const params = [userId];
  if (status) { where.push('status = ?'); params.push(status); }
  const sql = `SELECT id, tax_type, period, estimated_cents, filed_cents,
                      due_date, status, notes, created_at, updated_at
               FROM apc_tax_liabilities WHERE ${where.join(' AND ')}
               ORDER BY due_date ASC NULLS LAST, period DESC
               LIMIT ${lim} OFFSET ${off}`;
  const { results } = await db.prepare(sql).bind(...params).all();
  return (results || []).map(camelTax);
}

// ── Compliance Rules ──────────────────────────────────────────────────

export async function upsertComplianceRule(db, { userId, rule }) {
  if (!db) throw new Error('GRAPH_DB binding missing');
  const now = Date.now();
  const existing = await db.prepare(
    `SELECT id FROM apc_compliance_rules WHERE user_id = ? AND name = ? LIMIT 1`
  ).bind(userId, rule.name).first();
  if (existing) {
    await db.prepare(
      `UPDATE apc_compliance_rules
       SET description = ?, jurisdiction = ?, effective_date = ?, source_url = ?, updated_at = ?
       WHERE user_id = ? AND id = ?`
    ).bind(
      str(rule.description, 4000),
      str(rule.jurisdiction, 20) ?? 'BOTH',
      rule.effectiveDate ? Number(rule.effectiveDate) : null,
      str(rule.sourceUrl, 500) ?? null,
      now, userId, existing.id,
    ).run();
    return { id: existing.id, upserted: 'updated' };
  }
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO apc_compliance_rules
       (id, user_id, name, jurisdiction, description, effective_date, source_url, active, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,1,?,?)`
  ).bind(
    id, userId,
    str(rule.name, 200),
    str(rule.jurisdiction, 20) ?? 'BOTH',
    str(rule.description, 4000),
    rule.effectiveDate ? Number(rule.effectiveDate) : null,
    str(rule.sourceUrl, 500) ?? null,
    now, now,
  ).run();
  return { id, upserted: 'created' };
}

export async function listComplianceRules(db, { userId }) {
  if (!db) return [];
  const { results } = await db.prepare(
    `SELECT id, name, jurisdiction, description, effective_date, source_url, active, created_at
     FROM apc_compliance_rules WHERE user_id = ? AND active = 1
     ORDER BY jurisdiction, name`
  ).bind(userId).all();
  return (results || []).map(camelRule);
}

// ── Approval Events ───────────────────────────────────────────────────

export async function recordApprovalEvent(db, { userId, entityType, entityId, action, actor, notes, payload }) {
  if (!db) return null;
  const id = crypto.randomUUID();
  const ts = Date.now();
  await db.prepare(
    `INSERT INTO apc_approval_events
       (id, user_id, entity_type, entity_id, action, actor, notes, payload_json, ts)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, userId,
    str(entityType, 40),
    str(entityId, 36),
    str(action, 40),
    str(actor, 100) ?? 'user',
    str(notes, 2000) ?? null,
    JSON.stringify(payload ?? {}),
    ts,
  ).run();
  return { id, ts };
}

export async function listApprovalEvents(db, { userId, entityType, entityId, limit }) {
  if (!db) return [];
  const lim = clampInt(limit, 1, PAGE_MAX, 50);
  const where = ['user_id = ?'];
  const params = [userId];
  if (entityType) { where.push('entity_type = ?'); params.push(entityType); }
  if (entityId)   { where.push('entity_id = ?');   params.push(entityId); }
  const sql = `SELECT id, entity_type, entity_id, action, actor, notes, ts
               FROM apc_approval_events WHERE ${where.join(' AND ')}
               ORDER BY ts DESC LIMIT ${lim}`;
  const { results } = await db.prepare(sql).bind(...params).all();
  return results || [];
}

// ── Approval Queue ────────────────────────────────────────────────────
// Returns pending bills + pending proposals sorted by risk/due-date.

export async function getApprovalQueue(db, { userId }) {
  if (!db) return { bills: [], proposals: [] };
  const [billsRes, proposalsRes] = await Promise.all([
    db.prepare(
      `SELECT b.id, b.vendor_id, b.invoice_number, b.due_date, b.amount_cents,
              b.currency, b.tax_category, b.description, b.risk_score, b.source,
              b.created_at, v.name AS vendor_name
       FROM apc_bills b
       LEFT JOIN apc_vendors v ON v.user_id = b.user_id AND v.id = b.vendor_id
       WHERE b.user_id = ? AND b.status = 'pending'
       ORDER BY b.risk_score DESC, b.due_date ASC NULLS LAST
       LIMIT 100`
    ).bind(userId).all(),
    db.prepare(
      `SELECT p.id, p.bill_id, p.proposed_date, p.amount_cents, p.method,
              p.rationale, p.risk_score, p.created_at,
              b.invoice_number, b.description AS bill_description,
              v.name AS vendor_name
       FROM apc_payment_proposals p
       LEFT JOIN apc_bills b ON b.user_id = p.user_id AND b.id = p.bill_id
       LEFT JOIN apc_vendors v ON v.user_id = p.user_id AND v.id = b.vendor_id
       WHERE p.user_id = ? AND p.status = 'pending'
       ORDER BY p.risk_score DESC, p.proposed_date ASC
       LIMIT 100`
    ).bind(userId).all(),
  ]);
  return {
    bills: (billsRes.results || []).map(camelBill),
    proposals: (proposalsRes.results || []).map(camelProposal),
  };
}

// ── row → camelCase mappers ───────────────────────────────────────────

function camelVendor(r) {
  return {
    id: r.id, name: r.name, ein: r.ein, status: r.status,
    paymentTerms: r.payment_terms,
    earlyPayDiscountPct: r.early_pay_discount_pct,
    earlyPayDiscountDays: r.early_pay_discount_days,
    contactEmail: r.contact_email, contactPhone: r.contact_phone,
    notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function camelBill(r) {
  return {
    id: r.id, vendorId: r.vendor_id, vendorName: r.vendor_name ?? null,
    invoiceNumber: r.invoice_number, invoiceDate: r.invoice_date,
    dueDate: r.due_date, amountCents: r.amount_cents, currency: r.currency,
    taxCategory: r.tax_category, description: r.description,
    status: r.status, riskScore: r.risk_score, source: r.source,
    nodeId: r.node_id, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function camelProposal(r) {
  return {
    id: r.id, billId: r.bill_id,
    invoiceNumber: r.invoice_number ?? null,
    billDescription: r.bill_description ?? null,
    vendorName: r.vendor_name ?? null,
    proposedDate: r.proposed_date, amountCents: r.amount_cents,
    method: r.method, rationale: r.rationale,
    riskScore: r.risk_score, status: r.status,
    approvedAt: r.approved_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function camelTax(r) {
  return {
    id: r.id, taxType: r.tax_type, period: r.period,
    estimatedCents: r.estimated_cents, filedCents: r.filed_cents,
    dueDate: r.due_date, status: r.status, notes: r.notes,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function camelRule(r) {
  return {
    id: r.id, name: r.name, jurisdiction: r.jurisdiction,
    description: r.description, effectiveDate: r.effective_date,
    sourceUrl: r.source_url, active: !!r.active, createdAt: r.created_at,
  };
}

// ── micro-helpers ─────────────────────────────────────────────────────

function str(v, maxLen) {
  if (v == null) return undefined;
  return String(v).slice(0, maxLen);
}
function posInt(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}
function clampInt(v, lo, hi, dflt) {
  const n = Number.isFinite(+v) ? Math.floor(+v) : dflt;
  return Math.max(lo, Math.min(hi, n));
}
function clampFloat(v, lo, hi, dflt) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}
