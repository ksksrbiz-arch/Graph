// Phase 0 placeholder shell. The interactive graph canvas (react-force-graph,
// command palette, side panel) lands in Phase 3. Until then this renders a
// thin status card pointing visitors at the v1 viewer that already serves
// the live demo at https://graph.skdev-371.workers.dev.

import { useEffect, useState } from 'react';

interface ApiHealth {
  ok: boolean;
  enabled: boolean;
  formats?: string[];
}

const API_BASE = import.meta.env.VITE_API_URL ?? '/api/v1';

export function App(): JSX.Element {
  const [health, setHealth] = useState<ApiHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/public/ingest/health`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as ApiHealth;
      })
      .then((body) => {
        if (!cancelled) setHealth(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main
      style={{
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        background: '#0b0f1a',
        color: '#e8edf6',
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: '2rem',
      }}
    >
      <section
        style={{
          maxWidth: 540,
          background: '#11172a',
          border: '1px solid #1f2740',
          borderRadius: 16,
          padding: '2rem',
          boxShadow: '0 30px 90px rgba(0,0,0,0.55)',
        }}
      >
        <h1 style={{ margin: '0 0 0.4rem', fontSize: '1.4rem' }}>
          PKG-VS — Phase 0 scaffold
        </h1>
        <p style={{ margin: '0 0 1rem', color: '#aab3cc', lineHeight: 1.5 }}>
          The React 18 + Vite shell is up. The interactive canvas migrates in
          Phase 3; until then the live demo runs on the v1 static viewer at{' '}
          <a
            href="https://graph.skdev-371.workers.dev"
            style={{ color: '#7c9cff' }}
          >
            graph.skdev-371.workers.dev
          </a>
          .
        </p>
        <div style={{ marginTop: '1.2rem', fontSize: '0.85rem' }}>
          <strong>API health</strong>
          <pre
            style={{
              marginTop: '0.4rem',
              background: '#070a14',
              padding: '0.7rem 0.9rem',
              borderRadius: 8,
              border: '1px solid #1f2740',
              color: error ? '#ff8e8e' : '#9ad8ff',
              fontSize: '0.8rem',
            }}
          >
            {error ? `error: ${error}` : JSON.stringify(health, null, 2)}
          </pre>
        </div>
      </section>
    </main>
  );
}
