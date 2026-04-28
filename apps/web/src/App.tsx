import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  type ConnectorId,
  type SyncStatus,
} from '@pkg/shared';
import {
  CONNECTOR_CATALOG,
  CONNECTOR_CATEGORIES,
  type ConnectorCatalogEntry,
  type ConnectorCategory,
} from './connectorCatalog';

interface ApiHealth {
  ok: boolean;
  enabled: boolean;
  formats?: string[];
}

interface ConnectorSummary {
  id: ConnectorId;
  enabled: boolean;
  syncIntervalMinutes: number;
  lastSyncAt?: string;
  lastSyncStatus?: SyncStatus;
  rateLimitRemaining?: number;
  rateLimitResetsAt?: string;
  configured: boolean;
}

const API_BASE = import.meta.env.VITE_API_URL ?? '/api/v1';
const DEMO_USER_ID = 'local';

export function App(): JSX.Element {
  const [health, setHealth] = useState<ApiHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [connectors, setConnectors] = useState<Record<string, ConnectorSummary>>({});
  const [connectorsError, setConnectorsError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<ConnectorId | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [category, setCategory] = useState<'All' | ConnectorCategory>('All');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const liveFlag = { current: true };

    fetch(`${API_BASE}/public/ingest/health`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as ApiHealth;
      })
      .then((body) => {
        if (liveFlag.current) setHealth(body);
      })
      .catch((err: unknown) => {
        if (liveFlag.current) {
          setHealthError(err instanceof Error ? err.message : String(err));
        }
      });

    void loadConnectors(liveFlag, setConnectors, setConnectorsError);

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; connectorId?: string } | null;
      if (data?.source === 'pkg-oauth') {
        setNotice(`${humanizeConnectorId(data.connectorId)} connected. Sync starting…`);
        void loadConnectors(undefined, setConnectors, setConnectorsError);
      }
    };
    window.addEventListener('message', onMessage);

    return () => {
      liveFlag.current = false;
      window.removeEventListener('message', onMessage);
    };
  }, []);

  const filteredConnectors = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return CONNECTOR_CATALOG.filter((connector) => {
      if (category !== 'All' && connector.category !== category) return false;
      if (!needle) return true;
      return (
        connector.name.toLowerCase().includes(needle) ||
        connector.description.toLowerCase().includes(needle) ||
        connector.id.toLowerCase().includes(needle)
      );
    });
  }, [category, query]);

  const availableCount = CONNECTOR_CATALOG.filter(
    (connector) => connector.availability === 'available',
  ).length;
  const configuredCount = Object.values(connectors).filter((connector) => connector.configured).length;

  async function handlePrimaryAction(connector: ConnectorCatalogEntry): Promise<void> {
    if (connector.availability !== 'available') return;
    const summary = connectors[connector.id];
    if (summary?.configured) {
      await triggerSync(connector);
      return;
    }
    if (connector.setupMode === 'oauth') {
      await connectOAuth(connector);
      return;
    }
    await configureApiKey(connector);
  }

  async function connectOAuth(connector: ConnectorCatalogEntry): Promise<void> {
    setBusyId(connector.id);
    setConnectorsError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `${API_BASE}/oauth/connect/${connector.id}?userId=${encodeURIComponent(DEMO_USER_ID)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ returnTo: window.location.href }),
        },
      );
      if (!res.ok) throw await readError(res);
      const body = (await res.json()) as { authorizeUrl: string };
      const popup = window.open(body.authorizeUrl, '_blank', 'popup,width=560,height=760');
      if (!popup) window.location.assign(body.authorizeUrl);
      setNotice(`Opening ${connector.name} authorization…`);
    } catch (err) {
      setConnectorsError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function configureApiKey(connector: ConnectorCatalogEntry): Promise<void> {
    const apiKey = window.prompt(`Paste your ${connector.name} API key`);
    if (!apiKey?.trim()) return;

    const metadata =
      connector.id === 'zotero'
        ? optionalMetadata({
            groupId: window.prompt('Optional Zotero group id (leave blank for personal library)'),
          })
        : undefined;

    setBusyId(connector.id);
    setConnectorsError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `${API_BASE}/connectors/${connector.id}/configure?userId=${encodeURIComponent(DEMO_USER_ID)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ apiKey: apiKey.trim(), ...(metadata ? { metadata } : {}) }),
        },
      );
      if (!res.ok) throw await readError(res);
      await loadConnectors(undefined, setConnectors, setConnectorsError);
      setNotice(`${connector.name} configured. Initial ingest starting…`);
    } catch (err) {
      setConnectorsError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function triggerSync(connector: ConnectorCatalogEntry): Promise<void> {
    setBusyId(connector.id);
    setConnectorsError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `${API_BASE}/connectors/${connector.id}/sync?userId=${encodeURIComponent(DEMO_USER_ID)}`,
        { method: 'POST' },
      );
      if (!res.ok) throw await readError(res);
      setNotice(`${connector.name} sync enqueued.`);
      await loadConnectors(undefined, setConnectors, setConnectorsError);
    } catch (err) {
      setConnectorsError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main
      style={{
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        background:
          'radial-gradient(circle at top, rgba(74,110,255,0.18), transparent 35%), #0b0f1a',
        color: '#e8edf6',
        minHeight: '100vh',
        padding: '2rem',
      }}
    >
      <section style={{ maxWidth: 1280, margin: '0 auto' }}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            gap: '1rem',
            alignItems: 'flex-end',
            marginBottom: '1.5rem',
          }}
        >
          <div style={{ maxWidth: 720 }}>
            <p
              style={{
                margin: 0,
                color: '#7c9cff',
                fontSize: '0.8rem',
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
              }}
            >
              Connector roster
            </p>
            <h1 style={{ margin: '0.35rem 0 0.6rem', fontSize: '2.25rem' }}>
              One-click ingest catalog
            </h1>
            <p style={{ margin: 0, color: '#aab3cc', lineHeight: 1.6 }}>
              Started the expansion with a visible roster of {CONNECTOR_CATALOG.length} connectors.
              Live connectors can be connected in one click today; planned connectors stay visible so
              the roadmap is concrete while the backend fills in.
            </p>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: '0.8rem',
              minWidth: 'min(100%, 420px)',
              flex: 1,
            }}
          >
            <StatCard label="Roster size" value={String(CONNECTOR_CATALOG.length)} />
            <StatCard label="Available now" value={String(availableCount)} />
            <StatCard label="Configured" value={String(configuredCount)} />
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.25fr 0.9fr',
            gap: '1rem',
            marginBottom: '1rem',
          }}
        >
          <Panel>
            <div
              style={{
                display: 'flex',
                gap: '0.75rem',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <strong style={{ display: 'block', marginBottom: '0.35rem' }}>
                  Search and filter
                </strong>
                <span style={{ color: '#aab3cc', fontSize: '0.92rem' }}>
                  Narrow the roster, then connect live sources or track planned ones.
                </span>
              </div>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search connectors…"
                style={inputStyle}
              />
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '1rem' }}>
              {(['All', ...CONNECTOR_CATEGORIES] as const).map((entry) => {
                const active = category === entry;
                return (
                  <button
                    key={entry}
                    type="button"
                    onClick={() => setCategory(entry)}
                    style={{
                      ...chipStyle,
                      borderColor: active ? '#7c9cff' : '#1f2740',
                      background: active ? 'rgba(124,156,255,0.16)' : '#0d1324',
                      color: active ? '#eef3ff' : '#aab3cc',
                    }}
                  >
                    {entry}
                  </button>
                );
              })}
            </div>
          </Panel>

          <Panel>
            <strong style={{ display: 'block', marginBottom: '0.5rem' }}>System status</strong>
            <div style={{ color: '#aab3cc', fontSize: '0.92rem', lineHeight: 1.6 }}>
              <div>
                <span style={{ color: '#e8edf6' }}>API health:</span>{' '}
                {healthError ? `error: ${healthError}` : health ? JSON.stringify(health) : 'loading…'}
              </div>
              <div>
                <span style={{ color: '#e8edf6' }}>Connector sync user:</span> {DEMO_USER_ID}
              </div>
              <div>
                <span style={{ color: '#e8edf6' }}>Configured connectors:</span> {configuredCount}
              </div>
            </div>
          </Panel>
        </div>

        {(notice || connectorsError) && (
          <Panel
            style={{
              marginBottom: '1rem',
              borderColor: connectorsError ? '#5b2330' : '#1e3a2b',
              background: connectorsError ? '#1e1217' : '#0f1713',
            }}
          >
            <strong style={{ color: connectorsError ? '#ffb7c4' : '#9df1b5' }}>
              {connectorsError ? 'Action failed' : 'Connector update'}
            </strong>
            <div style={{ marginTop: '0.45rem', color: '#d5ddef' }}>
              {connectorsError ?? notice}
            </div>
          </Panel>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '1rem',
          }}
        >
          {filteredConnectors.map((connector) => {
            const summary = connectors[connector.id];
            const configured = Boolean(summary?.configured);
            const live = connector.availability === 'available';
            const primaryLabel = live
              ? configured
                ? 'Sync now'
                : connector.ctaLabel
              : 'Coming soon';

            return (
              <article
                key={connector.id}
                style={{
                  background: '#11172a',
                  border: '1px solid #1f2740',
                  borderRadius: 18,
                  padding: '1rem',
                  boxShadow: '0 20px 60px rgba(0,0,0,0.28)',
                  display: 'grid',
                  gap: '0.85rem',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: '0.8rem',
                  }}
                >
                  <div>
                    <h2 style={{ margin: 0, fontSize: '1.05rem' }}>{connector.name}</h2>
                    <div style={{ color: '#7c9cff', fontSize: '0.82rem', marginTop: '0.25rem' }}>
                      {connector.category}
                    </div>
                  </div>
                  <span
                    style={{
                      ...pillStyle,
                      background: live ? 'rgba(80, 212, 127, 0.12)' : 'rgba(160,174,192,0.12)',
                      color: live ? '#9df1b5' : '#c6cfde',
                    }}
                  >
                    {live ? 'available now' : 'planned'}
                  </span>
                </div>

                <p style={{ margin: 0, color: '#aab3cc', lineHeight: 1.55 }}>
                  {connector.description}
                </p>

                <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }}>
                  <span style={secondaryPillStyle}>{connector.setupMode === 'oauth' ? 'OAuth' : 'API key'}</span>
                  <span style={secondaryPillStyle}>{connector.id}</span>
                  {configured && <span style={secondaryPillStyle}>configured</span>}
                  {summary?.lastSyncStatus && (
                    <span style={secondaryPillStyle}>last sync: {summary.lastSyncStatus}</span>
                  )}
                </div>

                <div style={{ color: '#91a0bf', fontSize: '0.85rem', lineHeight: 1.5 }}>
                  {configured ? (
                    <>
                      <div>Sync interval: every {summary?.syncIntervalMinutes ?? 30} minutes</div>
                      <div>Last sync: {formatDate(summary?.lastSyncAt)}</div>
                    </>
                  ) : (
                    <div>
                      {live
                        ? 'Ready for one-click setup.'
                        : 'Visible in the roster now; backend ingest is not wired yet.'}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: '0.65rem', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    disabled={!live || busyId === connector.id}
                    onClick={() => {
                      void handlePrimaryAction(connector);
                    }}
                    style={{
                      ...buttonStyle,
                      background: live ? '#7c9cff' : '#1a2136',
                      color: live ? '#06112b' : '#7b859f',
                      cursor: !live || busyId === connector.id ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {busyId === connector.id ? 'Working…' : primaryLabel}
                  </button>

                  {live && connector.setupMode === 'apikey' && (
                    <button
                      type="button"
                      disabled={busyId === connector.id}
                      onClick={() => {
                        void configureApiKey(connector);
                      }}
                      style={buttonStyle}
                    >
                      {configured ? 'Update key' : 'Paste key'}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function Panel({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}): JSX.Element {
  return (
    <section
      style={{
        background: '#11172a',
        border: '1px solid #1f2740',
        borderRadius: 16,
        padding: '1rem',
        boxShadow: '0 18px 50px rgba(0,0,0,0.24)',
        ...style,
      }}
    >
      {children}
    </section>
  );
}

function StatCard({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div
      style={{
        background: '#11172a',
        border: '1px solid #1f2740',
        borderRadius: 16,
        padding: '1rem',
      }}
    >
      <div style={{ color: '#8f9aba', fontSize: '0.82rem' }}>{label}</div>
      <div style={{ fontSize: '1.7rem', fontWeight: 700, marginTop: '0.25rem' }}>{value}</div>
    </div>
  );
}

async function loadConnectors(
  liveFlag: { current: boolean } | undefined,
  setConnectors: Dispatch<SetStateAction<Record<string, ConnectorSummary>>>,
  setError: Dispatch<SetStateAction<string | null>>,
): Promise<void> {
  try {
    const res = await fetch(
      `${API_BASE}/connectors?userId=${encodeURIComponent(DEMO_USER_ID)}`,
    );
    if (!res.ok) throw await readError(res);
    const body = (await res.json()) as ConnectorSummary[];
    if (!liveFlag || liveFlag.current) {
      setConnectors(Object.fromEntries(body.map((connector) => [connector.id, connector])));
      setError(null);
    }
  } catch (err) {
    if (!liveFlag || liveFlag.current) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
}

async function readError(res: Response): Promise<Error> {
  const text = await res.text().catch(() => '');
  return new Error(text || `HTTP ${res.status}`);
}

function optionalMetadata(
  input: Record<string, string | null>,
): Record<string, string> | undefined {
  const entries = Object.entries(input).filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function formatDate(value: string | undefined): string {
  if (!value) return 'not synced yet';
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) return value;
  return new Date(millis).toLocaleString();
}

function humanizeConnectorId(value: string | undefined): string {
  if (!value) return 'Connector';
  const found = CONNECTOR_CATALOG.find((connector) => connector.id === value);
  return found?.name ?? value;
}

const inputStyle: CSSProperties = {
  minWidth: 240,
  borderRadius: 12,
  border: '1px solid #26304d',
  background: '#0d1324',
  color: '#e8edf6',
  padding: '0.8rem 0.9rem',
  outline: 'none',
};

const chipStyle: CSSProperties = {
  borderRadius: 999,
  border: '1px solid #1f2740',
  background: '#0d1324',
  padding: '0.5rem 0.8rem',
  fontSize: '0.82rem',
};

const pillStyle: CSSProperties = {
  borderRadius: 999,
  padding: '0.32rem 0.62rem',
  fontSize: '0.75rem',
  fontWeight: 600,
};

const secondaryPillStyle: CSSProperties = {
  ...pillStyle,
  background: '#0d1324',
  color: '#9caad0',
  border: '1px solid #24304f',
};

const buttonStyle: CSSProperties = {
  borderRadius: 12,
  border: '1px solid #26304d',
  background: '#121a2e',
  color: '#dce5ff',
  padding: '0.72rem 0.95rem',
  fontWeight: 600,
};
