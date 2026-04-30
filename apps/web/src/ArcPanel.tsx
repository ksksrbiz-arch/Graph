import { useEffect, useMemo, useState, type CSSProperties } from 'react';

interface ArcSummary {
  inflowCount: number;
  totalInflowCents: number;
  pendingQueue: number;
  pendingDepositCents: number;
  reconciledCount: number;
  unreconciledCount: number;
  clientCount: number;
  contractCount: number;
  taxableInflowCents: number;
}

interface QueueItem {
  id: string;
  label: string;
  accountName?: string;
  amountCents?: number;
  source?: string;
  rationale?: string;
  clientName?: string;
  occurredAt?: string;
  status?: string;
}

interface InflowItem {
  id: string;
  label: string;
  amountCents?: number;
  currency?: string;
  source?: string;
  clientName?: string;
  contractName?: string;
  invoiceNumber?: string;
  taxCategory?: string;
  occurredAt?: string;
  reconciled?: boolean;
}

interface ClientItem {
  id: string;
  label: string;
  email?: string;
  riskScore?: number;
}

export function ArcPanel({ apiBase, userId }: { apiBase: string; userId: string }): JSX.Element {
  const [summary, setSummary] = useState<ArcSummary | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [inflows, setInflows] = useState<InflowItem[]>([]);
  const [clients, setClients] = useState<ClientItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [csvText, setCsvText] = useState('date,client_name,contract_name,amount,currency,invoice_number,description,tax_category,ledger_ref,source\n2026-04-29,Demo Client,SaaS Retainer,1250,USD,INV-100,Monthly SaaS automation,WA_RETAIL_SALES_TAX_DIGITAL,LEDGER-100,bank');

  async function loadArc(): Promise<void> {
    try {
      const [summaryRes, queueRes, inflowRes, clientRes] = await Promise.all([
        fetchJson<ArcSummary>(`${apiBase}/arc/summary?userId=${encodeURIComponent(userId)}`),
        fetchJson<QueueItem[]>(`${apiBase}/arc/queue?userId=${encodeURIComponent(userId)}`),
        fetchJson<InflowItem[]>(`${apiBase}/arc/inflows?userId=${encodeURIComponent(userId)}&limit=20`),
        fetchJson<ClientItem[]>(`${apiBase}/arc/clients?userId=${encodeURIComponent(userId)}`),
      ]);
      setSummary(summaryRes);
      setQueue(queueRes);
      setInflows(inflowRes);
      setClients(clientRes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void loadArc();
  }, []);

  const statCards = useMemo(() => {
    if (!summary) return [];
    return [
      { label: 'Inflows', value: String(summary.inflowCount) },
      { label: 'Revenue', value: money(summary.totalInflowCents) },
      { label: 'Pending queue', value: String(summary.pendingQueue) },
      { label: 'Pending deposits', value: money(summary.pendingDepositCents) },
      { label: 'Clients', value: String(summary.clientCount) },
      { label: 'Contracts', value: String(summary.contractCount) },
      { label: 'Reconciled', value: `${summary.reconciledCount}/${summary.inflowCount}` },
      { label: 'Taxable', value: money(summary.taxableInflowCents) },
    ];
  }, [summary]);

  async function submitCsv(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await fetchJson<{ imported: number; matched: number }>(`${apiBase}/arc/ingest/bank-csv`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, csv: csvText }),
      });
      setNotice(`Imported ${result.imported} bank rows (${result.matched} matched).`);
      await loadArc();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function importSample(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await fetchJson<{ imported: number }>(`${apiBase}/arc/ingest/json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId,
          inflows: [
            {
              externalId: 'sample-github-001',
              source: 'github',
              amountCents: 2900,
              currency: 'USD',
              occurredAt: new Date().toISOString(),
              clientName: 'GitHub Sponsor Example',
              contractName: 'Bronze Sponsorship',
              invoiceNumber: 'GH-001',
              description: 'Monthly sponsor revenue',
              taxCategory: 'FEDERAL_1099_MISC',
            },
          ],
        }),
      });
      setNotice(`Imported ${result.imported} sample inflow.`);
      await loadArc();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ marginBottom: '1rem', display: 'grid', gap: '1rem' }}>
      <div>
        <p style={{ margin: 0, color: '#7c9cff', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
          Accounts Receivable Cortex
        </p>
        <h2 style={{ margin: '0.35rem 0 0.5rem', fontSize: '1.8rem' }}>Incoming money automation</h2>
        <p style={{ margin: 0, color: '#aab3cc', lineHeight: 1.6 }}>
          ARC ingests bank rows and structured inflows, classifies revenue, creates deposit proposals, and records reconciliation events in the existing graph.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.8rem' }}>
        {statCards.map((card) => (
          <div key={card.label} style={statStyle}>
            <div style={{ color: '#8f9aba', fontSize: '0.82rem' }}>{card.label}</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, marginTop: '0.25rem' }}>{card.value}</div>
          </div>
        ))}
      </div>

      {(notice || error) && (
        <section style={{ ...panelStyle, borderColor: error ? '#5b2330' : '#1e3a2b', background: error ? '#1e1217' : '#0f1713' }}>
          <strong style={{ color: error ? '#ffb7c4' : '#9df1b5' }}>{error ? 'ARC action failed' : 'ARC update'}</strong>
          <div style={{ marginTop: '0.45rem', color: '#d5ddef' }}>{error ?? notice}</div>
        </section>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: '1rem' }}>
        <section style={panelStyle}>
          <strong style={{ display: 'block', marginBottom: '0.65rem' }}>Bank CSV ingest</strong>
          <p style={helpStyle}>Paste a bank export to create RevenueInflow, TaxClassification, DepositProposal, and ReconciliationEvent nodes.</p>
          <textarea value={csvText} onChange={(event) => setCsvText(event.target.value)} rows={8} style={textareaStyle} />
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <button type="button" onClick={() => void submitCsv()} disabled={busy} style={primaryButtonStyle}>
              {busy ? 'Importing…' : 'Import bank CSV'}
            </button>
            <button type="button" onClick={() => void importSample()} disabled={busy} style={secondaryButtonStyle}>
              Load sample inflow
            </button>
          </div>
        </section>

        <section style={panelStyle}>
          <strong style={{ display: 'block', marginBottom: '0.65rem' }}>Pending approval queue</strong>
          <div style={{ display: 'grid', gap: '0.65rem' }}>
            {queue.length === 0 ? (
              <span style={{ color: '#91a0bf' }}>No pending deposit proposals yet.</span>
            ) : (
              queue.slice(0, 6).map((item) => (
                <div key={item.id} style={queueCardStyle}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
                    <strong>{item.clientName ?? item.label}</strong>
                    <span style={pillStyle}>{money(item.amountCents)}</span>
                  </div>
                  <div style={{ color: '#aab3cc', fontSize: '0.88rem', marginTop: '0.3rem' }}>
                    {item.accountName} · {item.source} · {formatDate(item.occurredAt)}
                  </div>
                  {item.rationale && <div style={{ color: '#91a0bf', marginTop: '0.4rem', lineHeight: 1.5 }}>{item.rationale}</div>}
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 0.9fr', gap: '1rem' }}>
        <section style={panelStyle}>
          <strong style={{ display: 'block', marginBottom: '0.65rem' }}>Recent inflows</strong>
          <div style={{ display: 'grid', gap: '0.6rem' }}>
            {inflows.length === 0 ? (
              <span style={{ color: '#91a0bf' }}>No inflows yet.</span>
            ) : (
              inflows.map((item) => (
                <div key={item.id} style={rowStyle}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{item.clientName ?? item.label}</div>
                    <div style={{ color: '#8f9aba', fontSize: '0.84rem', marginTop: '0.2rem' }}>
                      {item.contractName ?? 'No contract'} · {item.invoiceNumber ?? 'No invoice'} · {item.taxCategory ?? 'NONE'}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontWeight: 700 }}>{money(item.amountCents, item.currency)}</div>
                    <div style={{ color: item.reconciled ? '#9df1b5' : '#ffcf85', fontSize: '0.82rem', marginTop: '0.2rem' }}>
                      {item.reconciled ? 'reconciled' : 'needs review'}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section style={panelStyle}>
          <strong style={{ display: 'block', marginBottom: '0.65rem' }}>Clients</strong>
          <div style={{ display: 'grid', gap: '0.55rem' }}>
            {clients.length === 0 ? (
              <span style={{ color: '#91a0bf' }}>No ARC clients yet.</span>
            ) : (
              clients.map((item) => (
                <div key={item.id} style={rowStyle}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{item.label}</div>
                    <div style={{ color: '#8f9aba', fontSize: '0.84rem', marginTop: '0.2rem' }}>{item.email ?? 'email unknown'}</div>
                  </div>
                  <span style={pillStyle}>risk {(Number(item.riskScore ?? 0) * 100).toFixed(0)}%</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  const text = await res.text();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  return JSON.parse(text) as T;
}

function money(value: number | undefined, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format((value ?? 0) / 100);
}

function formatDate(value: string | undefined): string {
  if (!value) return 'unknown date';
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) return value;
  return new Date(millis).toLocaleDateString();
}

const panelStyle: CSSProperties = {
  background: '#11172a',
  border: '1px solid #1f2740',
  borderRadius: 16,
  padding: '1rem',
  boxShadow: '0 18px 50px rgba(0,0,0,0.24)',
};

const statStyle: CSSProperties = {
  background: '#11172a',
  border: '1px solid #1f2740',
  borderRadius: 16,
  padding: '1rem',
};

const helpStyle: CSSProperties = { margin: '0 0 0.75rem', color: '#aab3cc', fontSize: '0.92rem', lineHeight: 1.5 };
const textareaStyle: CSSProperties = {
  width: '100%',
  minHeight: 170,
  borderRadius: 12,
  border: '1px solid #26304d',
  background: '#0d1324',
  color: '#e8edf6',
  padding: '0.9rem',
  outline: 'none',
  marginBottom: '0.75rem',
};
const primaryButtonStyle: CSSProperties = {
  borderRadius: 12,
  border: '1px solid #26304d',
  background: '#7c9cff',
  color: '#06112b',
  padding: '0.72rem 0.95rem',
  fontWeight: 600,
};
const secondaryButtonStyle: CSSProperties = {
  borderRadius: 12,
  border: '1px solid #26304d',
  background: '#121a2e',
  color: '#dce5ff',
  padding: '0.72rem 0.95rem',
  fontWeight: 600,
};
const queueCardStyle: CSSProperties = { border: '1px solid #24304f', borderRadius: 12, padding: '0.8rem', background: '#0d1324' };
const rowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '0.75rem',
  alignItems: 'center',
  border: '1px solid #24304f',
  borderRadius: 12,
  padding: '0.8rem',
  background: '#0d1324',
};
const pillStyle: CSSProperties = {
  borderRadius: 999,
  padding: '0.28rem 0.62rem',
  fontSize: '0.75rem',
  fontWeight: 600,
  background: '#16213b',
  color: '#9dc4ff',
  border: '1px solid #24304f',
};
