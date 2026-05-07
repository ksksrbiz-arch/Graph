# Batch folder upload

The graph view's **Brain ingest** panel ships with a `Batch` tab that lets you
drop or pick a whole project folder and import it into the knowledge graph in
one shot. The browser walks every file, routes it to a parser based on its
extension, and posts the resulting `{nodes, edges}` to the existing public
ingest API in chunks.

This document is the canonical reference for what the pipeline accepts, what
it skips, and the shape of the graph fragment it produces.

## Where the work happens

1. **Folder picking / drag-drop** — `<input type="file" webkitdirectory>` for
   the picker, `DataTransferItemList` + `webkitGetAsEntry()` for drag-drop
   (recursive).
2. **Pre-flight** — files are bucketed by extension, total bytes are summed,
   and skipped files (with reasons) are listed before anything is uploaded.
3. **Browser-side parsing** — each kept file is read with `Blob.text()` and
   dispatched to a parser in [`web/batch-parsers/`](../web/batch-parsers/).
4. **Chunked upload** — the merged `{nodes, edges}` bundle is split into
   ≤1 500-node / ≤6 000-edge chunks and posted to
   `POST /api/v1/public/ingest/graph` (which is sanitized by the Worker before
   the KV merge — see `sanitizeGraphNode` / `sanitizeGraphEdge` in
   `src/worker.js`).
5. **Live refresh** — on success the panel calls `loadGraph()` so the new
   nodes appear in the force-graph immediately.

## Supported file types

| Category    | Extensions                                                           | Parser                                  |
| ----------- | -------------------------------------------------------------------- | --------------------------------------- |
| Markdown    | `.md`, `.markdown`                                                   | Headings → `note` nodes, `#tags`, `[[wikilinks]]`, URLs |
| Plain text  | `.txt`, `.log`, `.rst`                                               | Paragraph splitter                      |
| HTML        | `.html`, `.htm`                                                      | Tag-strip → text parser                 |
| JSON        | `.json`                                                              | Top-level keys → `concept` nodes (capped at 40) |
| CSV / TSV   | `.csv`, `.tsv`                                                       | Header fields → `concept` nodes         |
| Source code | `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx`, `.py`, `.go`, `.java`, `.rb`, `.rs`, `.cs`, `.c`, `.h`, `.cpp`, `.cc`, `.hpp`, `.hh`, `.sh`, `.bash`, `.zsh` | Cheap-regex import/require extraction → `IMPORTS` edges, plus cross-file `REFERENCES` edges for relative imports |
| Config      | `.yml`, `.yaml`, `.toml`, `.ini`, `.env`, `.cfg`, `.conf`, `.xml`, `.svg`, `.sql`, `.gql`, `.graphql` | Plain-text fallback                     |
| Extensionless | `README`, `LICENSE`, `LICENCE`, `CHANGELOG`, `AUTHORS`, `CONTRIBUTORS`, `Makefile`, `Dockerfile`, `Jenkinsfile` | Plain-text fallback                     |

Anything not on this allow-list is skipped with reason `binary` (the same
applies to anything that's textually identifiable but happens to contain a
NUL byte in its first 8 KiB — those are routed away from the parser to avoid
polluting the graph).

## Hard skips (folders + files)

The following directory segments are ignored anywhere in the path:

- `.git`, `.idea`, `.vscode`, `.cache`, `.gradle`, `.mvn`
- `node_modules`, `dist`, `build`, `.next`, `.nuxt`, `target`, `__pycache__`
- `.venv`, `venv`, `coverage`, `vendor`

Lockfiles are skipped by basename: `package-lock.json`, `pnpm-lock.yaml`,
`yarn.lock`, `poetry.lock`, `Pipfile.lock`, `Cargo.lock`, `go.sum`,
`composer.lock`, `Gemfile.lock`.

## Limits

| Limit              | Default     | Why                                                       |
| ------------------ | ----------- | --------------------------------------------------------- |
| Per-file bytes     | 1 MiB       | A single huge file would dominate the graph and slow parsing. |
| Total bytes        | 20 MiB      | Browser memory + upload time guardrail.                   |
| File count         | 1 000       | Same.                                                     |
| Per-request nodes  | 1 500 (chunked) | Worker enforces 5 000 per request; we leave headroom. |
| Per-request edges  | 6 000 (chunked) | Worker enforces 20 000 per request; same.            |

The defaults live in `web/batch-parsers/index.js` (`DEFAULT_LIMITS`) and
`web/data.js` (`ingestPublicBatch`).

## Resulting graph shape

```
                                ┌──────────────┐
                                │   <source>   │   type=source, label=<folder name>
                                └──────┬───────┘
                  CONTAINS  ┌─────────┘ │ └──────────┐
                            ▼           ▼            ▼
                     ┌──────────┐ ┌──────────┐ ┌──────────┐
                     │ <folder> │ │ <folder> │ │  <file>  │
                     └────┬─────┘ └────┬─────┘ └────┬─────┘
                          │ CONTAINS   │            │ EXTRACTED_FROM
                          ▼            ▼            ▼
                     ┌──────────┐ ┌──────────┐ ┌──────────────────┐
                     │  <file>  │ │  <file>  │ │  <note/concept/  │
                     └────┬─────┘ └────┬─────┘ │   tag/bookmark>  │
                          │ IMPORTS    │       └──────────────────┘
                          ▼            │
                     ┌──────────┐      │ REFERENCES (cross-file, relative imports)
                     │ <module> │      └────────────► <file>
                     └──────────┘
```

Every node carries `sourceId = "batch-<slug>-<utc-stamp>"`, `metadata.path`,
`metadata.ext`, and `metadata.bytes`. IDs are SHA-256-derived from
`(sourceId, role, relativePath, …)` — re-uploading the same folder produces
the same IDs, and the Worker's `mergeAndPersist` (in `src/worker.js`) will
merge them into existing nodes rather than creating duplicates.

## Adding a new parser

1. Add the parsing function to `web/batch-parsers/parsers.js`. It receives
   `(text, ctx)` where `ctx = { relativePath, sourceId, fileNodeId, now }` and
   should return `{ nodes, edges }` (and optionally `imports: string[]` for
   the cross-file resolver to use). Build nodes/edges via
   `makeNode` / `makeEdge` from `util.js` so IDs stay deterministic.
2. Register the extension in `web/batch-parsers/index.js`:
   - Add the extension to `PARSER_BY_EXT` and add a case in `dispatchParse`.
   - If it's source code, add it to `SOURCE_EXTENSIONS` and the import-pattern
     map in `parsers.js` instead.
3. No backend changes are needed — the new nodes/edges flow through the
   existing `/api/v1/public/ingest/graph` endpoint and the same KV merge
   path used by the URL/Text tabs.

## Out of scope (for now)

- **Binary formats** (PDF, DOCX, images, audio). The hybrid approach in the
  plan reserved these for a future server-side parsing endpoint
  (`POST /api/v1/public/ingest/files`); not implemented.
- **Connectors-view card.** The Batch tab is the canonical surface in the
  ingest panel. A duplicate connectors-view card was deferred — folder
  upload doesn't fit the connector "configure once, re-run on a schedule"
  model that powers the rest of that view.
