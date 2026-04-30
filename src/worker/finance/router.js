// Accounts Payable Cortex — API router.
//
// All routes are under /api/v1/finance/* and require a userId that is on
// the PUBLIC_INGEST_USER_IDS allowlist (same guard as cortex routes).
//
// Routes:
//   GET  /api/v1/finance/queue                  — approval queue (bills + proposals)
//   GET  /api/v1/finance/vendors                 — list vendors
//   POST /api/v1/finance/vendors                 — create vendor
//   GET  /api/v1/finance/vendors/:id             — get vendor
//   PUT  /api/v1/finance/vendors/:id             — update vendor
//   GET  /api/v1/finance/bills                   — list bills
//   POST /api/v1/finance/bills                   — create bill (manual)
//   GET  /api/v1/finance/bills/:id               — get bill
//   PUT  /api/v1/finance/bills/:id/status        — update bill status
//   POST /api/v1/finance/bills/ingest            — ingest invoice (text or image)
//   GET  /api/v1/finance/proposals               — list payment proposals
//   POST /api/v1/finance/proposals/:id/approve   — approve/reject proposal
//   GET  /api/v1/finance/tax                     — list tax liabilities
//   POST /api/v1/finance/tax                     — upsert tax liability
//   GET  /api/v1/finance/rules                   — list compliance rules
//   POST /api/v1/finance/rules                   — upsert compliance rule
//   GET  /api/v1/finance/events                  — list approval events

import {
  createVendor, listVendors, getVendor, updateVendor,
  createBill, listBills, getBill, updateBillStatus,
  createProposal, listProposals, approveProposal,
  upsertTaxLiability, listTaxLiabilities,
  upsertComplianceRule, listComplianceRules,
  recordApprovalEvent, listApprovalEvents,
  getApprovalQueue,
} from './store.js';
import { extractFromText, extractFromImage } from './invoice-parser.js';
import { upsertNodesAndEdges } from '../d1-store.js';

export async function handleFinanceApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (!pathname.startsWith('/api/v1/finance')) return null;

  const userId = getUserId(request, url);
  if (!userId) return json({ error: 'userId required (query param or JSON body)' }, 400);
  if (!checkUser(userId, env)) return forbidden(userId);
  if (!env.GRAPH_DB)           return json({ error: 'GRAPH_DB binding missing' }, 503);

  // ── Approval Queue ──────────────────────────────────────────────────
  if (pathname === '/api/v1/finance/queue' && method === 'GET') {
    const queue = await getApprovalQueue(env.GRAPH_DB, { userId });
    return json(queue);
  }

  // ── Vendors ─────────────────────────────────────────────────────────
  if (pathname === '/api/v1/finance/vendors') {
    if (method === 'GET') {
      const vendors = await listVendors(env.GRAPH_DB, {
        userId,
        status: url.searchParams.get('status') || undefined,
        limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset'),
      });
      return json({ vendors });
    }
    if (method === 'POST') {
      const body = await safeJson(request);
      if (!body?.vendor) return json({ error: 'vendor object required' }, 400);
      if (!body.vendor.name) return json({ error: 'vendor.name required' }, 400);
      const result = await createVendor(env.GRAPH_DB, { userId, vendor: body.vendor });
      // Mirror as a graph node
      await mirrorNode(env, userId, { id: 'vendor:' + result.id, type: 'vendor', label: body.vendor.name, metadata: { vendorId: result.id } });
      return json(result, 201);
    }
  }

  const vendorMatch = pathname.match(/^\/api\/v1\/finance\/vendors\/([^/]+)$/);
  if (vendorMatch) {
    const vendorId = vendorMatch[1];
    if (method === 'GET') {
      const vendor = await getVendor(env.GRAPH_DB, { userId, vendorId });
      if (!vendor) return json({ error: 'not found' }, 404);
      return json(vendor);
    }
    if (method === 'PUT') {
      const body = await safeJson(request);
      if (!body) return json({ error: 'invalid JSON' }, 400);
      const result = await updateVendor(env.GRAPH_DB, { userId, vendorId, patch: body });
      return json(result);
    }
  }

  // ── Bills ────────────────────────────────────────────────────────────
  if (pathname === '/api/v1/finance/bills') {
    if (method === 'GET') {
      const bills = await listBills(env.GRAPH_DB, {
        userId,
        status: url.searchParams.get('status') || undefined,
        vendorId: url.searchParams.get('vendorId') || undefined,
        limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset'),
      });
      return json({ bills });
    }
    if (method === 'POST') {
      const body = await safeJson(request);
      if (!body?.bill) return json({ error: 'bill object required' }, 400);
      const result = await createBill(env.GRAPH_DB, { userId, bill: body.bill });
      const vendorName = body.bill.vendorName || body.bill.vendorId || 'Unknown Vendor';
      await mirrorNode(env, userId, { id: 'bill:' + result.id, type: 'bill', label: `Invoice ${body.bill.invoiceNumber || result.id}`, metadata: { billId: result.id, vendorName, amountCents: body.bill.amountCents } });
      return json(result, 201);
    }
  }

  // POST /api/v1/finance/bills/ingest — AI invoice extraction
  if (pathname === '/api/v1/finance/bills/ingest' && method === 'POST') {
    const ct = request.headers.get('content-type') || '';
    let extracted;

    if (ct.includes('application/json')) {
      const body = await safeJson(request);
      if (!body) return json({ error: 'invalid JSON' }, 400);

      if (body.image) {
        // base64 image
        let imageBytes;
        try { imageBytes = base64ToBytes(body.image); } catch {
          return json({ error: 'image must be valid base64' }, 400);
        }
        extracted = await extractFromImage(env, imageBytes);
      } else if (body.text) {
        extracted = await extractFromText(env, body.text);
      } else {
        return json({ error: 'provide image (base64) or text' }, 400);
      }
    } else {
      return json({ error: 'content-type must be application/json' }, 415);
    }

    if (!extracted.ok) return json({ error: extracted.error }, 422);

    // Optionally auto-create the vendor if not found
    let vendorId = null;
    if (extracted.vendorName) {
      const existing = await env.GRAPH_DB.prepare(
        `SELECT id FROM apc_vendors WHERE user_id = ? AND name = ? LIMIT 1`
      ).bind(userId, extracted.vendorName).first();
      if (existing) {
        vendorId = existing.id;
      } else {
        const v = await createVendor(env.GRAPH_DB, { userId, vendor: { name: extracted.vendorName } });
        vendorId = v.id;
        await mirrorNode(env, userId, { id: 'vendor:' + vendorId, type: 'vendor', label: extracted.vendorName, metadata: { vendorId } });
      }
    }

    // Auto-score risk: overdue or no due date = higher risk
    const now = Date.now();
    const isOverdue = extracted.dueDate && extracted.dueDate < now;
    const riskScore = isOverdue ? 0.8 : (!extracted.dueDate ? 0.4 : 0.2);

    const billData = {
      vendorId,
      invoiceNumber: extracted.invoiceNumber,
      invoiceDate: extracted.invoiceDate,
      dueDate: extracted.dueDate,
      amountCents: extracted.amountCents,
      currency: extracted.currency,
      taxCategory: extracted.taxCategory,
      description: extracted.description,
      riskScore,
      source: 'vision',
      rawText: extracted.rawText,
      data: { lineItems: extracted.lineItems },
    };
    const result = await createBill(env.GRAPH_DB, { userId, bill: billData });

    // Mirror bill as graph node
    const label = `Invoice ${extracted.invoiceNumber || result.id}${extracted.vendorName ? ' · ' + extracted.vendorName : ''}`;
    await mirrorNode(env, userId, {
      id: 'bill:' + result.id, type: 'bill', label,
      metadata: { billId: result.id, vendorId, amountCents: extracted.amountCents, taxCategory: extracted.taxCategory },
    });

    return json({ ...result, extracted }, 201);
  }

  const billMatch = pathname.match(/^\/api\/v1\/finance\/bills\/([^/]+)$/);
  if (billMatch) {
    const billId = billMatch[1];
    if (method === 'GET') {
      const bill = await getBill(env.GRAPH_DB, { userId, billId });
      if (!bill) return json({ error: 'not found' }, 404);
      return json(bill);
    }
  }

  const billStatusMatch = pathname.match(/^\/api\/v1\/finance\/bills\/([^/]+)\/status$/);
  if (billStatusMatch && method === 'PUT') {
    const billId = billStatusMatch[1];
    const body = await safeJson(request);
    if (!body?.status) return json({ error: 'status required' }, 400);
    try {
      const result = await updateBillStatus(env.GRAPH_DB, { userId, billId, status: body.status });
      await recordApprovalEvent(env.GRAPH_DB, {
        userId, entityType: 'bill', entityId: billId,
        action: body.status, actor: 'user', notes: body.notes,
        payload: { status: body.status },
      });
      return json(result);
    } catch (err) {
      return json({ error: err.message }, 400);
    }
  }

  // ── Payment Proposals ────────────────────────────────────────────────
  if (pathname === '/api/v1/finance/proposals') {
    if (method === 'GET') {
      const proposals = await listProposals(env.GRAPH_DB, {
        userId,
        status: url.searchParams.get('status') || undefined,
        limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset'),
      });
      return json({ proposals });
    }
    if (method === 'POST') {
      const body = await safeJson(request);
      if (!body?.proposal?.billId) return json({ error: 'proposal.billId required' }, 400);
      const result = await createProposal(env.GRAPH_DB, { userId, proposal: body.proposal });
      return json(result, 201);
    }
  }

  const propApproveMatch = pathname.match(/^\/api\/v1\/finance\/proposals\/([^/]+)\/approve$/);
  if (propApproveMatch && method === 'POST') {
    const proposalId = propApproveMatch[1];
    const body = await safeJson(request);
    if (!body?.action) return json({ error: 'action required (approved|rejected)' }, 400);
    try {
      const result = await approveProposal(env.GRAPH_DB, {
        userId, proposalId, action: body.action, notes: body.notes,
      });
      await recordApprovalEvent(env.GRAPH_DB, {
        userId, entityType: 'payment_proposal', entityId: proposalId,
        action: body.action, actor: 'user', notes: body.notes,
        payload: { action: body.action },
      });
      return json(result);
    } catch (err) {
      return json({ error: err.message }, 400);
    }
  }

  // ── Tax Liabilities ──────────────────────────────────────────────────
  if (pathname === '/api/v1/finance/tax') {
    if (method === 'GET') {
      const liabilities = await listTaxLiabilities(env.GRAPH_DB, {
        userId,
        status: url.searchParams.get('status') || undefined,
        limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset'),
      });
      return json({ liabilities });
    }
    if (method === 'POST') {
      const body = await safeJson(request);
      if (!body?.liability?.taxType || !body?.liability?.period) {
        return json({ error: 'liability.taxType and liability.period required' }, 400);
      }
      const result = await upsertTaxLiability(env.GRAPH_DB, { userId, liability: body.liability });
      return json(result, 201);
    }
  }

  // ── Compliance Rules ─────────────────────────────────────────────────
  if (pathname === '/api/v1/finance/rules') {
    if (method === 'GET') {
      const rules = await listComplianceRules(env.GRAPH_DB, { userId });
      return json({ rules });
    }
    if (method === 'POST') {
      const body = await safeJson(request);
      if (!body?.rule?.name || !body?.rule?.description) {
        return json({ error: 'rule.name and rule.description required' }, 400);
      }
      const result = await upsertComplianceRule(env.GRAPH_DB, { userId, rule: body.rule });
      return json(result, 201);
    }
  }

  // ── Approval Events ──────────────────────────────────────────────────
  if (pathname === '/api/v1/finance/events' && method === 'GET') {
    const events = await listApprovalEvents(env.GRAPH_DB, {
      userId,
      entityType: url.searchParams.get('entityType') || undefined,
      entityId: url.searchParams.get('entityId') || undefined,
      limit: url.searchParams.get('limit'),
    });
    return json({ events });
  }

  return null;
}

// ── helpers ───────────────────────────────────────────────────────────

async function mirrorNode(env, userId, { id, type, label, metadata }) {
  if (!env.GRAPH_DB) return;
  const merge = env.__mergeAndPersist;
  const node = { id, type, label, metadata: metadata ?? {} };
  await upsertNodesAndEdges(env.GRAPH_DB, {
    userId, sourceKind: 'finance',
    nodes: [node], edges: [],
  });
  if (typeof merge === 'function' && env.GRAPH_KV) {
    await merge(env.GRAPH_KV, userId, { nodes: [node], edges: [] }, 'finance');
  }
}

function getUserId(request, url) {
  const fromQuery = (url.searchParams.get('userId') || '').trim();
  return fromQuery || null;
  // Body-based userId is resolved in each POST handler directly from parsed body.
  // For GET requests the query param is the only option.
}

function checkUser(userId, env) {
  if (!userId) return false;
  const csv = (env.PUBLIC_INGEST_USER_IDS || 'local').toString();
  return csv.split(',').map((s) => s.trim()).filter(Boolean).includes(userId);
}

function forbidden(userId) {
  return json({ error: `userId=${userId} not on allowlist` }, 403);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function safeJson(request) {
  try { return await request.json(); } catch { return null; }
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
