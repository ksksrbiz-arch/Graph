import { describe, expect, it } from 'vitest';
import {
  DepositProposalRecordSchema,
  RevenueInflowInputSchema,
  ReconciliationEventRecordSchema,
  TaxClassificationRecordSchema,
} from '../index.js';

const now = new Date().toISOString();

describe('financial schemas', () => {
  it('accepts a valid revenue inflow input', () => {
    const result = RevenueInflowInputSchema.safeParse({
      source: 'stripe',
      amountCents: 2900,
      currency: 'USD',
      occurredAt: now,
      clientName: 'Acme Co',
      invoiceNumber: 'INV-100',
      taxCategory: 'WA_BO_SERVICE',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a negative inflow amount', () => {
    const result = RevenueInflowInputSchema.safeParse({
      source: 'bank',
      amountCents: -1,
      currency: 'USD',
      occurredAt: now,
      clientName: 'Acme Co',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a tax classification record', () => {
    const result = TaxClassificationRecordSchema.safeParse({
      code: 'WA_RETAIL_SALES_TAX_DIGITAL',
      jurisdiction: 'WA',
      description: 'WA digital automated services taxability',
      rateBps: 650,
      collectible: true,
      effectiveFrom: now,
    });
    expect(result.success).toBe(true);
  });

  it('accepts deposit proposal and reconciliation records', () => {
    const inflowId = '00000000-0000-4000-8000-000000000001';
    expect(
      DepositProposalRecordSchema.safeParse({
        inflowId,
        accountName: 'Operating',
        operatingPercent: 80,
        reservePercent: 20,
        rationale: 'Hold a reserve for WA tax remittance.',
        status: 'pending',
      }).success,
    ).toBe(true);
    expect(
      ReconciliationEventRecordSchema.safeParse({
        inflowId,
        invoiceNumber: 'INV-42',
        ledgerRef: 'LEDGER-42',
        status: 'matched',
        matchedAt: now,
      }).success,
    ).toBe(true);
  });
});
