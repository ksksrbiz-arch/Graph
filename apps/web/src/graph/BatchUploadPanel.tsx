import { useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { ingestGraph, type GraphIngestResult } from './api';
import {
  chunkBundle,
  filesFromDrop,
  filesFromInput,
  parseAll,
  planFiles,
  type PickedFile,
  type PlanResult,
} from './batch/parse';

type Phase = 'idle' | 'ready' | 'working' | 'done' | 'error';

interface Totals {
  nodes: number;
  edges: number;
  skippedNodes: number;
  skippedEdges: number;
}

function deriveSourceId(files: PickedFile[]): string {
  const first = files[0]?.path ?? '';
  const top = first.includes('/') ? first.slice(0, first.indexOf('/')) : '';
  return (top || 'batch-upload').slice(0, 60);
}

export function BatchUploadPanel({
  userId,
  onClose,
  onIngested,
}: {
  userId: string;
  onClose: () => void;
  onIngested: () => void;
}): JSX.Element {
  const dirInput = useRef<HTMLInputElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [sourceId, setSourceId] = useState('batch-upload');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [dragOver, setDragOver] = useState(false);

  function accept(files: PickedFile[]): void {
    const result = planFiles(files);
    setPlan(result);
    setSourceId(deriveSourceId(files));
    setError(null);
    setTotals(null);
    setPhase(result.kept.length > 0 ? 'ready' : 'error');
    if (result.kept.length === 0) setError('No ingestable files found in that selection.');
  }

  async function onDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    setDragOver(false);
    accept(await filesFromDrop(e.dataTransfer.items));
  }

  async function runIngest(): Promise<void> {
    if (!plan || plan.kept.length === 0) return;
    setPhase('working');
    setError(null);
    try {
      setProgress(`Parsing 0/${plan.kept.length} files…`);
      const bundle = await parseAll(plan.kept, sourceId.trim() || 'batch-upload', (done, total) =>
        setProgress(`Parsing ${done}/${total} files…`),
      );
      const chunks = chunkBundle(bundle);
      const agg: Totals = { nodes: 0, edges: 0, skippedNodes: 0, skippedEdges: 0 };
      for (const [i, chunk] of chunks.entries()) {
        setProgress(`Uploading chunk ${i + 1}/${chunks.length}…`);
        const res: GraphIngestResult = await ingestGraph(userId, {
          nodes: chunk.nodes,
          edges: chunk.edges,
          sourceId: sourceId.trim() || 'batch-upload',
        });
        agg.nodes += res.nodes;
        agg.edges += res.edges;
        agg.skippedNodes += res.skippedNodes;
        agg.skippedEdges += res.skippedEdges;
      }
      setTotals(agg);
      setPhase('done');
      onIngested();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }

  const busy = phase === 'working';

  return (
    <div style={backdrop} onClick={busy ? undefined : onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong style={{ fontSize: '1.05rem' }}>Batch folder upload</strong>
          <button type="button" onClick={onClose} disabled={busy} style={iconBtn} aria-label="Close">
            ✕
          </button>
        </div>
        <p style={{ color: '#aab3cc', fontSize: '0.86rem', margin: '6px 0 12px', lineHeight: 1.5 }}>
          Drop or pick a project folder. Files are parsed in your browser into a graph fragment and
          ingested. Skips <code>.git</code>, <code>node_modules</code>, build output, binaries, and
          files over 1&nbsp;MiB.
        </p>

        <div
          style={{ ...dropzone, borderColor: dragOver ? '#7c9cff' : '#2a3550' }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => void onDrop(e)}
        >
          <div style={{ color: '#dce5ff', marginBottom: 10 }}>Drag a folder here, or</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button type="button" style={btn} onClick={() => dirInput.current?.click()} disabled={busy}>
              Pick folder
            </button>
            <button type="button" style={btn} onClick={() => fileInput.current?.click()} disabled={busy}>
              Pick files
            </button>
          </div>
          <input
            ref={dirInput}
            type="file"
            multiple
            // webkitdirectory/directory aren't in the standard input prop types.
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            style={{ display: 'none' }}
            onChange={(e) => e.target.files && accept(filesFromInput(e.target.files))}
          />
          <input
            ref={fileInput}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => e.target.files && accept(filesFromInput(e.target.files))}
          />
        </div>

        {plan && (
          <div style={{ marginTop: 12, fontSize: '0.86rem', color: '#dce5ff' }}>
            <div>
              <strong>{plan.kept.length}</strong> file{plan.kept.length === 1 ? '' : 's'} to ingest ·{' '}
              {(plan.totalBytes / 1024).toFixed(0)} KiB · {plan.skipped.length} skipped
            </div>
            {plan.skipped.length > 0 && (
              <details style={{ marginTop: 6 }}>
                <summary style={{ cursor: 'pointer', color: '#aab3cc' }}>Show skipped</summary>
                <ul style={skippedList}>
                  {plan.skipped.slice(0, 50).map((s) => (
                    <li key={s.path}>
                      <span style={{ color: '#7b86a3' }}>{s.reason}</span> · {s.path}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <label style={{ display: 'block', marginTop: 10 }}>
              <span style={{ color: '#aab3cc', fontSize: '0.8rem' }}>Source label</span>
              <input
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
                disabled={busy}
                style={textInput}
              />
            </label>
          </div>
        )}

        {progress && busy && <div style={{ marginTop: 12, color: '#9caad0' }}>{progress}</div>}

        {error && (
          <div style={{ marginTop: 12, color: '#ffb7c4', fontSize: '0.86rem' }}>{error}</div>
        )}

        {totals && phase === 'done' && (
          <div style={doneBox}>
            Ingested <strong>{totals.nodes}</strong> nodes and <strong>{totals.edges}</strong> edges.
            {totals.skippedNodes + totals.skippedEdges > 0 && (
              <span style={{ color: '#9caad0' }}>
                {' '}
                ({totals.skippedNodes + totals.skippedEdges} sanitised out)
              </span>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          {phase === 'done' ? (
            <button type="button" style={primaryBtn} onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button type="button" style={btn} onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                style={{ ...primaryBtn, opacity: !plan || plan.kept.length === 0 || busy ? 0.5 : 1 }}
                disabled={!plan || plan.kept.length === 0 || busy}
                onClick={() => void runIngest()}
              >
                {busy ? 'Working…' : `Ingest ${plan?.kept.length ?? 0} files`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const backdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(4,7,14,0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 30,
};
const modal: CSSProperties = {
  width: 'min(560px, 92vw)',
  maxHeight: '86vh',
  overflowY: 'auto',
  background: 'rgba(17,23,42,0.98)',
  border: '1px solid #26304d',
  borderRadius: 16,
  padding: '1.2rem',
  boxShadow: '0 30px 90px rgba(0,0,0,0.6)',
  color: '#e8edf6',
};
const dropzone: CSSProperties = {
  border: '1.5px dashed #2a3550',
  borderRadius: 14,
  padding: '1.5rem',
  textAlign: 'center',
  background: '#0d1324',
};
const btn: CSSProperties = {
  borderRadius: 10,
  border: '1px solid #26304d',
  background: '#121a2e',
  color: '#dce5ff',
  padding: '0.55rem 0.85rem',
  fontWeight: 600,
  cursor: 'pointer',
  fontSize: '0.85rem',
};
const primaryBtn: CSSProperties = {
  ...btn,
  background: '#7c9cff',
  color: '#06112b',
  border: '1px solid #7c9cff',
};
const iconBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#8fa0c8',
  cursor: 'pointer',
  fontSize: '1rem',
};
const textInput: CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 4,
  borderRadius: 10,
  border: '1px solid #26304d',
  background: '#0d1324',
  color: '#e8edf6',
  padding: '0.5rem 0.7rem',
  outline: 'none',
};
const skippedList: CSSProperties = {
  listStyle: 'none',
  margin: '6px 0 0',
  padding: 0,
  maxHeight: 140,
  overflowY: 'auto',
  fontSize: '0.78rem',
  color: '#c6cfde',
  display: 'grid',
  gap: 2,
};
const doneBox: CSSProperties = {
  marginTop: 12,
  padding: '0.6rem 0.8rem',
  borderRadius: 10,
  background: '#0f1713',
  border: '1px solid #1e3a2b',
  color: '#9df1b5',
  fontSize: '0.88rem',
};
