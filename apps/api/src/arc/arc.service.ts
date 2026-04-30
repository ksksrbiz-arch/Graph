import { ForbiddenException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import type { ConnectorId, EdgeRelation, KGEdge, KGNode, NodeType } from '@pkg/shared';
import { ARC_GRAPH_NODE_TYPES, RevenueInflowInputSchema, type RevenueInflowInput, type TaxCategoryCode } from '@pkg/shared';
import { createHash } from 'node:crypto';
import { loadEnv } from '../config/env';
import { splitCsvEnv } from '../config/env-utils';
import { GraphService } from '../graph/graph.service';

const ARC_NODE_TYPES = new Set<NodeType>(ARC_GRAPH_NODE_TYPES);
const MAX_CSV_BYTES = 512 * 1024;

@Injectable()
export class ArcService {
  private readonly env = loadEnv();
  private readonly allowedUserIds = new Set(splitCsvEnv(this.env.PUBLIC_INGEST_USER_IDS));

  constructor(private readonly graph: GraphService) {}

  health(): { ok: boolean; enabled: boolean; sources: string[] } {
    return { ok: true, enabled: this.allowedUserIds.size > 0, sources: ['bank', 'stripe', 'github', 'manual'] };
  }

  assertAllowed(userId: string, contentLength = 0): void {
    if (!this.allowedUserIds.has(userId)) {
      throw new ForbiddenException(`userId=${userId} is not on the ARC allowlist`);
    }
    if (contentLength > MAX_CSV_BYTES) {
      throw new PayloadTooLargeException(`payload exceeds ${MAX_CSV_BYTES} bytes (got ${contentLength})`);
    }
  }

  async summary(userId: string): Promise<Record<string, unknown>> {
    const nodes = await this.financialNodes(userId);
    const inflows = nodes.filter((n) => n.type === 'revenue_inflow');
    const proposals = nodes.filter((n) => n.type === 'deposit_proposal');
    const reconciliations = nodes.filter((n) => n.type === 'reconciliation_event');
    const clients = nodes.filter((n) => n.type === 'client');
    const contracts = nodes.filter((n) => n.type === 'contract');
    const totalInflowCents = inflows.reduce((sum, n) => sum + num(n.metadata.amountCents), 0);
    const pendingDepositCents = proposals
      .filter((n) => String(n.metadata.status ?? 'pending') === 'pending')
      .reduce((sum, n) => sum + num(n.metadata.amountCents), 0);
    const reconciledCount = reconciliations.filter((n) => String(n.metadata.status) === 'matched').length;
    const pendingQueue = proposals.filter((n) => String(n.metadata.status ?? 'pending') === 'pending').length;
    const taxableCents = inflows
      .filter((n) => String(n.metadata.taxCategory ?? 'NONE') !== 'NONE')
      .reduce((sum, n) => sum + num(n.metadata.amountCents), 0);

    return {
      inflowCount: inflows.length,
      totalInflowCents,
      pendingQueue,
      pendingDepositCents,
      reconciledCount,
      unreconciledCount: Math.max(inflows.length - reconciledCount, 0),
      clientCount: clients.length,
      contractCount: contracts.length,
      taxableInflowCents: taxableCents,
    };
  }

  async queue(userId: string): Promise<Array<Record<string, unknown>>> {
    const nodes = await this.financialNodes(userId);
    return nodes
      .filter((n) => n.type === 'deposit_proposal' && String(n.metadata.status ?? 'pending') === 'pending')
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((n) => ({
        id: n.id,
        label: n.label,
        accountName: n.metadata.accountName,
        amountCents: n.metadata.amountCents,
        source: n.metadata.source,
        rationale: n.metadata.rationale,
        clientName: n.metadata.clientName,
        occurredAt: n.metadata.occurredAt,
        status: n.metadata.status ?? 'pending',
      }));
  }

  async inflows(userId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const nodes = await this.financialNodes(userId);
    return nodes
      .filter((n) => n.type === 'revenue_inflow')
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit)
      .map((n) => ({
        id: n.id,
        label: n.label,
        amountCents: n.metadata.amountCents,
        currency: n.metadata.currency,
        source: n.metadata.source,
        clientName: n.metadata.clientName,
        contractName: n.metadata.contractName,
        invoiceNumber: n.metadata.invoiceNumber,
        taxCategory: n.metadata.taxCategory,
        occurredAt: n.metadata.occurredAt,
        reconciled: Boolean(n.metadata.reconciled),
      }));
  }

  async clients(userId: string): Promise<Array<Record<string, unknown>>> {
    const nodes = await this.financialNodes(userId);
    return nodes
      .filter((n) => n.type === 'client')
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((n) => ({ id: n.id, label: n.label, email: n.metadata.email, riskScore: n.metadata.riskScore ?? 0 }));
  }

  async ingestJson(userId: string, inflows: RevenueInflowInput[]): Promise<{ imported: number }> {
    this.assertAllowed(userId);
    for (const raw of inflows) {
      const entry = RevenueInflowInputSchema.parse(raw);
      await this.persistInflow(userId, entry);
    }
    return { imported: inflows.length };
  }

  async ingestBankCsv(userId: string, csv: string): Promise<{ imported: number; matched: number }> {
    this.assertAllowed(userId, Buffer.byteLength(csv, 'utf8'));
    const inflows = parseBankCsv(csv);
    for (const entry of inflows) {
      await this.persistInflow(userId, entry);
    }
    return {
      imported: inflows.length,
      matched: inflows.filter((entry) => Boolean(entry.invoiceNumber || entry.ledgerRef)).length,
    };
  }

  private async financialNodes(userId: string): Promise<KGNode[]> {
    this.assertAllowed(userId);
    const snapshot = await this.graph.snapshotForUser(userId, 10_000);
    return snapshot.nodes.filter((node) => ARC_NODE_TYPES.has(node.type));
  }

  private async persistInflow(userId: string, entry: RevenueInflowInput): Promise<void> {
    const sourceId = connectorForSource(entry.source);
    const occurredAt = entry.occurredAt;
    const clientId = stableUuid(`arc|client|${userId}|${entry.clientExternalId ?? entry.clientName.toLowerCase()}`);
    const contractId = entry.contractName || entry.contractExternalId
      ? stableUuid(`arc|contract|${userId}|${entry.contractExternalId ?? entry.contractName?.toLowerCase()}`)
      : null;
    const inflowId = stableUuid(`arc|inflow|${userId}|${entry.externalId ?? `${entry.source}|${entry.clientName}|${entry.amountCents}|${entry.occurredAt}|${entry.invoiceNumber ?? ''}`}`);
    const taxCategory = entry.taxCategory ?? inferTaxCategory(entry);
    const reservePercent = clampPercent(entry.reservePercent ?? defaultReservePercent(taxCategory));
    const operatingPercent = 100 - reservePercent;
    const proposalId = stableUuid(`arc|proposal|${inflowId}`);
    const reconciliationId = stableUuid(`arc|reconcile|${inflowId}`);
    const taxClassId = stableUuid(`arc|tax|${userId}|${taxCategory}`);
    const now = new Date().toISOString();
    const matched = Boolean(entry.invoiceNumber || entry.ledgerRef || contractId);

    const clientNode = node({
      id: clientId,
      label: entry.clientName,
      type: 'client',
      sourceId,
      createdAt: occurredAt,
      metadata: {
        externalId: entry.clientExternalId,
        email: entry.clientEmail,
        riskScore: matched ? 0.15 : 0.35,
      },
    });

    const contractNode = contractId
      ? node({
          id: contractId,
          label: entry.contractName ?? `Contract ${entry.contractExternalId}`,
          type: 'contract',
          sourceId,
          createdAt: occurredAt,
          metadata: {
            externalId: entry.contractExternalId,
            status: 'active',
            paymentTermsDays: 30,
            recurring: entry.source === 'stripe',
          },
        })
      : null;

    const inflowNode = node({
      id: inflowId,
      label: `${entry.clientName} · ${(entry.amountCents / 100).toFixed(2)} ${entry.currency}`,
      type: 'revenue_inflow',
      sourceId,
      createdAt: occurredAt,
      metadata: {
        externalId: entry.externalId,
        amountCents: entry.amountCents,
        currency: entry.currency,
        source: entry.source,
        clientName: entry.clientName,
        contractName: entry.contractName,
        invoiceNumber: entry.invoiceNumber,
        description: entry.description,
        taxCategory,
        occurredAt,
        reconciled: matched,
        ledgerRef: entry.ledgerRef,
        ...entry.metadata,
      },
    });

    const taxNode = node({
      id: taxClassId,
      label: humanizeTaxCategory(taxCategory),
      type: 'tax_classification',
      sourceId,
      createdAt: occurredAt,
      metadata: {
        code: taxCategory,
        jurisdiction: taxCategory.startsWith('WA_') ? 'WA' : taxCategory.startsWith('FEDERAL_') ? 'FEDERAL' : 'WA',
        collectible: taxCategory === 'WA_RETAIL_SALES_TAX_DIGITAL',
        rateBps: taxRateBps(taxCategory),
        effectiveFrom: '2025-10-01T00:00:00.000Z',
      },
    });

    const proposalNode = node({
      id: proposalId,
      label: `Deposit ${entry.clientName} → Operating ${operatingPercent}% / Reserve ${reservePercent}%`,
      type: 'deposit_proposal',
      sourceId,
      createdAt: now,
      metadata: {
        inflowId,
        amountCents: entry.amountCents,
        source: entry.source,
        accountName: 'Operating Account',
        operatingPercent,
        reservePercent,
        clientName: entry.clientName,
        occurredAt,
        rationale:
          reservePercent > 0
            ? `Hold ${reservePercent}% in reserve for taxes and forecasted obligations.`
            : 'Deposit fully to operating cash.',
        status: 'pending',
      },
    });

    const reconciliationNode = node({
      id: reconciliationId,
      label: matched ? `Reconciled ${entry.clientName}` : `Needs review ${entry.clientName}`,
      type: 'reconciliation_event',
      sourceId,
      createdAt: now,
      metadata: {
        inflowId,
        invoiceNumber: entry.invoiceNumber,
        ledgerRef: entry.ledgerRef,
        status: matched ? 'matched' : 'needs_review',
        matchedAt: matched ? now : null,
      },
    });

    const nodes = [clientNode, inflowNode, taxNode, proposalNode, reconciliationNode, contractNode].filter(Boolean) as KGNode[];
    for (const item of nodes) {
      await this.graph.upsertNode(userId, item);
    }

    const edges: KGEdge[] = [
      edge(clientId, inflowId, 'FUNDS', { source: entry.source }),
      edge(inflowId, taxClassId, 'CLASSIFIED_AS', { code: taxCategory }),
      edge(proposalId, inflowId, 'PROPOSES', { operatingPercent, reservePercent }),
      edge(reconciliationId, inflowId, 'RECONCILES', { status: matched ? 'matched' : 'needs_review' }),
    ];
    if (contractId) {
      edges.push(edge(contractId, inflowId, 'BILLED_TO', { invoiceNumber: entry.invoiceNumber ?? null }));
      edges.push(edge(clientId, contractId, 'PART_OF', { kind: 'client-contract' }));
    }
    for (const item of edges) {
      await this.graph.upsertEdge(userId, item);
    }
  }
}

function parseBankCsv(csv: string): RevenueInflowInput[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0] ?? '').map((h) => h.trim());
  return lines.slice(1).map((line, index) => {
    const cols = parseCsvLine(line);
    const row = Object.fromEntries(headers.map((header, i) => [header, cols[i]?.trim() ?? '']));
    const amount = Math.round(Number.parseFloat(row.amount || row.amount_usd || '0') * 100);
    const occurredAt = new Date(row.date || row.occurred_at || new Date().toISOString()).toISOString();
    return RevenueInflowInputSchema.parse({
      externalId: row.external_id || row.id || `csv-${index + 1}`,
      source: normalizeSource(row.source || 'bank'),
      amountCents: Math.max(amount, 0),
      currency: row.currency || 'USD',
      occurredAt,
      clientName: row.client || row.client_name || row.description || 'Unknown client',
      clientEmail: row.client_email || undefined,
      contractName: row.contract || row.contract_name || undefined,
      contractExternalId: row.contract_id || undefined,
      invoiceNumber: row.invoice || row.invoice_number || undefined,
      description: row.description || row.memo || undefined,
      taxCategory: normalizeTaxCategory(row.tax_category),
      ledgerRef: row.ledger_ref || row.bank_ref || undefined,
      metadata: {
        bankAccount: row.account || row.bank_account || undefined,
        rawRow: row,
      },
    });
  });
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"') {
      if (quoted && next === '"') {
        cur += '"';
        i++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function node(args: {
  id: string;
  label: string;
  type: NodeType;
  sourceId: ConnectorId;
  createdAt: string;
  metadata: Record<string, unknown>;
}): KGNode {
  return {
    id: args.id,
    label: args.label,
    type: args.type,
    sourceId: args.sourceId,
    createdAt: args.createdAt,
    updatedAt: new Date().toISOString(),
    metadata: args.metadata,
  };
}

function edge(source: string, target: string, relation: EdgeRelation, metadata: Record<string, unknown>): KGEdge {
  return {
    id: stableUuid(`arc|edge|${source}|${relation}|${target}`),
    source,
    target,
    relation,
    weight: 0.8,
    inferred: false,
    createdAt: new Date().toISOString(),
    metadata,
  };
}

function stableUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16] ?? '0', 16) % 4] ?? '8';
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20, 32)}`;
}

function connectorForSource(source: RevenueInflowInput['source']): ConnectorId {
  if (source === 'stripe') return 'stripe';
  if (source === 'github') return 'github';
  return 'quickbooks';
}

function normalizeSource(source: string): RevenueInflowInput['source'] {
  const value = source.trim().toLowerCase();
  if (value === 'stripe' || value === 'github' || value === 'manual') return value;
  return 'bank';
}

function normalizeTaxCategory(value: string | undefined): TaxCategoryCode | undefined {
  const normalized = value?.trim().toUpperCase();
  if (!normalized) return undefined;
  const allowed: TaxCategoryCode[] = [
    'WA_BO_SERVICE',
    'WA_BO_RETAILING',
    'WA_RETAIL_SALES_TAX_DIGITAL',
    'FEDERAL_1099K',
    'FEDERAL_1099_MISC',
    'NONE',
  ];
  return allowed.includes(normalized as TaxCategoryCode) ? (normalized as TaxCategoryCode) : undefined;
}

function inferTaxCategory(entry: RevenueInflowInput): TaxCategoryCode {
  if (entry.source === 'github') return 'FEDERAL_1099_MISC';
  const text = `${entry.description ?? ''} ${entry.contractName ?? ''}`.toLowerCase();
  if (/digital|software|saas|automation|hosting|ads|advertis/.test(text)) {
    return 'WA_RETAIL_SALES_TAX_DIGITAL';
  }
  if (/retail|product|store|merch/.test(text)) return 'WA_BO_RETAILING';
  return 'WA_BO_SERVICE';
}

function defaultReservePercent(category: TaxCategoryCode): number {
  if (category === 'WA_RETAIL_SALES_TAX_DIGITAL') return 25;
  if (category.startsWith('WA_')) return 15;
  if (category.startsWith('FEDERAL_')) return 10;
  return 5;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function humanizeTaxCategory(category: TaxCategoryCode): string {
  return category.replace(/_/g, ' ');
}

function taxRateBps(category: TaxCategoryCode): number {
  switch (category) {
    case 'WA_BO_SERVICE':
      return 180;
    case 'WA_BO_RETAILING':
      return 471;
    case 'WA_RETAIL_SALES_TAX_DIGITAL':
      return 650;
    case 'FEDERAL_1099K':
    case 'FEDERAL_1099_MISC':
      return 0;
    default:
      return 0;
  }
}

function num(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}
