import { z } from 'zod';

export const REVENUE_SOURCES = ['bank', 'stripe', 'github', 'manual'] as const;
export type RevenueSource = (typeof REVENUE_SOURCES)[number];
export const RevenueSourceSchema = z.enum(REVENUE_SOURCES);

export const TAX_CATEGORY_CODES = [
  'WA_BO_SERVICE',
  'WA_BO_RETAILING',
  'WA_RETAIL_SALES_TAX_DIGITAL',
  'FEDERAL_1099K',
  'FEDERAL_1099_MISC',
  'NONE',
] as const;
export type TaxCategoryCode = (typeof TAX_CATEGORY_CODES)[number];
export const TaxCategoryCodeSchema = z.enum(TAX_CATEGORY_CODES);

export const RECONCILIATION_STATUS = ['matched', 'needs_review', 'unmatched'] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUS)[number];
export const ReconciliationStatusSchema = z.enum(RECONCILIATION_STATUS);

export const DEPOSIT_PROPOSAL_STATUS = ['pending', 'approved', 'rejected', 'executed'] as const;
export const ARC_GRAPH_NODE_TYPES = [
  'revenue_inflow',
  'client',
  'contract',
  'tax_classification',
  'deposit_proposal',
  'reconciliation_event',
] as const;

export type DepositProposalStatus = (typeof DEPOSIT_PROPOSAL_STATUS)[number];
export const DepositProposalStatusSchema = z.enum(DEPOSIT_PROPOSAL_STATUS);

export interface RevenueInflowInput {
  externalId?: string;
  source: RevenueSource;
  amountCents: number;
  currency: string;
  occurredAt: string;
  clientName: string;
  clientExternalId?: string;
  clientEmail?: string;
  contractName?: string;
  contractExternalId?: string;
  invoiceNumber?: string;
  description?: string;
  taxCategory?: TaxCategoryCode;
  reservePercent?: number;
  ledgerRef?: string;
  metadata?: Record<string, unknown>;
}

export interface ClientRecord {
  externalId?: string;
  name: string;
  email?: string;
  riskScore?: number;
  notes?: string;
}

export interface ContractRecord {
  externalId?: string;
  name: string;
  paymentTermsDays?: number;
  recurring?: boolean;
  status?: 'active' | 'paused' | 'closed';
}

export interface TaxClassificationRecord {
  code: TaxCategoryCode;
  jurisdiction: 'WA' | 'FEDERAL' | 'MULTISTATE';
  description: string;
  rateBps?: number;
  collectible?: boolean;
  effectiveFrom?: string;
}

export interface DepositProposalRecord {
  inflowId: string;
  accountName: string;
  operatingPercent: number;
  reservePercent: number;
  rationale: string;
  status?: DepositProposalStatus;
}

export interface ReconciliationEventRecord {
  inflowId: string;
  invoiceNumber?: string;
  ledgerRef?: string;
  status: ReconciliationStatus;
  matchedAt?: string;
}

const isoDateString = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'expected ISO-8601 timestamp' });

export const RevenueInflowInputSchema = z.object({
  externalId: z.string().max(200).optional(),
  source: RevenueSourceSchema,
  amountCents: z.number().int().nonnegative(),
  currency: z.string().min(3).max(8).default('USD'),
  occurredAt: isoDateString,
  clientName: z.string().min(1).max(200),
  clientExternalId: z.string().max(200).optional(),
  clientEmail: z.string().email().optional(),
  contractName: z.string().max(200).optional(),
  contractExternalId: z.string().max(200).optional(),
  invoiceNumber: z.string().max(120).optional(),
  description: z.string().max(1000).optional(),
  taxCategory: TaxCategoryCodeSchema.optional().default('NONE'),
  reservePercent: z.number().min(0).max(100).optional(),
  ledgerRef: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ClientRecordSchema = z.object({
  externalId: z.string().max(200).optional(),
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  riskScore: z.number().min(0).max(1).optional(),
  notes: z.string().max(2000).optional(),
});

export const ContractRecordSchema = z.object({
  externalId: z.string().max(200).optional(),
  name: z.string().min(1).max(200),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  recurring: z.boolean().optional(),
  status: z.enum(['active', 'paused', 'closed']).optional(),
});

export const TaxClassificationRecordSchema = z.object({
  code: TaxCategoryCodeSchema,
  jurisdiction: z.enum(['WA', 'FEDERAL', 'MULTISTATE']),
  description: z.string().min(1).max(1000),
  rateBps: z.number().int().min(0).max(100_000).optional(),
  collectible: z.boolean().optional(),
  effectiveFrom: isoDateString.optional(),
});

export const DepositProposalRecordSchema = z.object({
  inflowId: z.string().uuid(),
  accountName: z.string().min(1).max(120),
  operatingPercent: z.number().min(0).max(100),
  reservePercent: z.number().min(0).max(100),
  rationale: z.string().min(1).max(1000),
  status: DepositProposalStatusSchema.optional(),
});

export const ReconciliationEventRecordSchema = z.object({
  inflowId: z.string().uuid(),
  invoiceNumber: z.string().max(120).optional(),
  ledgerRef: z.string().max(200).optional(),
  status: ReconciliationStatusSchema,
  matchedAt: isoDateString.optional(),
});
