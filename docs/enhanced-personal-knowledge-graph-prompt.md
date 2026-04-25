# Personal Knowledge Graph Visualization System — Enhanced Specification v2.0

> **How to use this document**
> Copy the entire contents into GitHub Copilot (agent mode), Cursor, Claude Projects, or any LLM coding agent and instruct it:
> *"Implement the complete Personal Knowledge Graph Visualization System exactly as specified below. Begin with Phase 0 and proceed sequentially through all phases. Generate every file, test, diagram, and document described."*

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Vision Statement & Target Personas](#2-vision-statement--target-personas)
3. [System Architecture Overview](#3-system-architecture-overview)
4. [Non-Functional Requirements (NFRs)](#4-non-functional-requirements-nfrs)
5. [Data Schemas & Type Contracts](#5-data-schemas--type-contracts)
6. [API Contract](#6-api-contract)
7. [Frontend Specification](#7-frontend-specification)
8. [Backend Specification](#8-backend-specification)
9. [Connector Specifications](#9-connector-specifications)
10. [Security & Privacy](#10-security--privacy)
11. [Testing Strategy](#11-testing-strategy)
12. [Implementation Roadmap (8 Phases)](#12-implementation-roadmap-8-phases)
13. [DevOps & Observability](#13-devops--observability)
14. [AI Agent Instructions (25 Rules)](#14-ai-agent-instructions-25-rules)
15. [Risk Register](#15-risk-register)
16. [Appendices](#16-appendices)

---

## 1. Executive Summary

The **Personal Knowledge Graph Visualization System** (PKG-VS) is a web application that ingests a user's digital footprint (emails, notes, calendar events, tasks, bookmarks, code repositories, documents) and renders it as an interactive force-directed graph. Users navigate their own knowledge network visually, discovering hidden connections, clustering related concepts, and exporting insights.

**Core value proposition:** Replace linear search with spatial navigation of personal knowledge.

**Scope boundaries (strictly preserved from v1.0):**
- Single-user, self-hosted or SaaS deployment
- Web-only (no native mobile apps)
- Supported data sources: Gmail/Outlook, Notion/Obsidian/Roam, GitHub/GitLab, Google Calendar/Outlook Calendar, Todoist/Linear, browser bookmarks
- Graph visualization only (no AI content generation)

---

## 2. Vision Statement & Target Personas

### 2.1 Vision Statement

> *"Every piece of knowledge a person creates or consumes should be one visual hop away from every related piece."*

### 2.2 Target Personas

| Persona | Description | Primary Use Case |
|---------|-------------|-----------------|
| **Research Scholar** | Academic managing 500+ papers, notes, and citations | Discover citation clusters, literature gaps |
| **Knowledge Worker** | Product manager juggling emails, tasks, docs, and meetings | Connect decisions to context, reduce meeting prep time |
| **Software Engineer** | Developer tracking issues, PRs, docs, and Slack threads | Navigate codebase knowledge, link bugs to commits |
| **Personal Learner** | Lifelong learner building a second brain | Visualize learning paths, spaced-repetition triggers |

---

## 3. System Architecture Overview

### 3.1 Layers

```
┌─────────────────────────────────────────────────────────────────┐
│  Presentation Layer (React 18 + TypeScript)                      │
│  react-force-graph-2d/3d · Zustand · React Query · Radix UI     │
├─────────────────────────────────────────────────────────────────┤
│  API Gateway Layer (NestJS 10 + GraphQL + REST + WebSocket)      │
│  Guards · Rate limiting · JWT/OAuth2 · OpenAPI docs              │
├─────────────────────────────────────────────────────────────────┤
│  Domain / Application Layer (Clean Architecture)                 │
│  Use cases · Domain entities · Repository interfaces             │
├─────────────────────────────────────────────────────────────────┤
│  Infrastructure Layer                                            │
│  Neo4j (graph DB) · PostgreSQL (relational) · Redis (cache)      │
│  BullMQ (job queues) · S3-compatible object store               │
├─────────────────────────────────────────────────────────────────┤
│  Connector Layer (NLP + OAuth2 integrations)                     │
│  Gmail · Outlook · Notion · Obsidian · GitHub · GitLab           │
│  Google Calendar · Outlook Calendar · Todoist · Linear           │
│  Browser Bookmarks (OPML/HTML import)                           │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Mermaid C4 Context Diagram (description)

*See Appendix D for full Mermaid source.*
A `Person` (User) interacts with the `PKG-VS Web App` (system boundary). The web app communicates with `External OAuth Providers` (Google, Microsoft, GitHub, Notion, Todoist/Linear) and with the `Neo4j + PostgreSQL + Redis` data stores. A `Background Sync Worker` (BullMQ) polls connectors on a schedule.

### 3.3 Technology Choices with Rationales

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Frontend framework | React 18 | Concurrent rendering; widest ecosystem |
| Graph renderer | react-force-graph-2d (primary), react-force-graph-3d (opt-in) | WebGL-accelerated, handles 10k+ nodes |
| State management | Zustand | Minimal boilerplate; works with React Concurrent |
| Data fetching | React Query + Apollo Client | REST caching + GraphQL subscriptions |
| UI primitives | Radix UI + Tailwind CSS | Accessible by default; headless primitives |
| Backend framework | NestJS 10 | Built-in DI, Guards, Pipes, OpenAPI, WebSocket |
| Graph database | Neo4j 5 | Native graph traversal; Cypher query language |
| Relational database | PostgreSQL 15 | User accounts, audit logs, connector configs |
| Cache / pub-sub | Redis 7 | BullMQ queues, real-time event bus |
| Search | Meilisearch | Full-text node/edge search with typo tolerance |
| Containerization | Docker + Docker Compose | Reproducible local dev; production parity |
| CI/CD | GitHub Actions | Native to this repo; matrix builds |

---

## 4. Non-Functional Requirements (NFRs)

### 4.1 Performance Budget

| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| Initial graph render (1,000 nodes) | < 2.5 s on 4G mobile | Lighthouse CI |
| Graph interaction frame rate | ≥ 60 fps @ 5,000 nodes (desktop) | Chrome DevTools FPS meter |
| Graph interaction frame rate | ≥ 30 fps @ 5,000 nodes (mobile) | Chrome DevTools FPS meter |
| Time to interactive (TTI) | < 3.5 s (Lighthouse) | Lighthouse CI |
| Lighthouse Performance score | ≥ 95 | Lighthouse CI |
| API p95 response time (graph fetch) | < 200 ms | Prometheus + Grafana |
| Background sync latency | < 5 min after connector event | BullMQ job timestamps |
| WebSocket message delivery | < 50 ms p99 | Server-side instrumentation |

### 4.2 Scalability

| Metric | Target |
|--------|--------|
| Nodes per user graph | Up to 50,000 nodes |
| Edges per user graph | Up to 200,000 edges |
| Concurrent active users (SaaS) | 1,000 |
| Background sync jobs/hour | 10,000 |

### 4.3 Reliability & Availability

| Metric | Target |
|--------|--------|
| Sync service uptime | 99.5% monthly |
| API uptime | 99.9% monthly |
| RTO (Recovery Time Objective) | < 1 hour |
| RPO (Recovery Point Objective) | < 15 minutes |

### 4.4 Accessibility

- WCAG 2.2 Level AA compliance for all UI components
- Full keyboard navigation of graph canvas (Tab, Arrow keys, Enter to open node)
- Screen-reader announcements for graph state changes (ARIA live regions)
- Minimum contrast ratio: 4.5:1 for normal text, 3:1 for large text
- Focus-visible outlines on all interactive elements

### 4.5 Security

- OWASP Top 10 mitigations (see §10)
- All secrets in environment variables or a secrets manager (never in source)
- TLS 1.3 in transit; AES-256-GCM at rest
- Per-user data encryption keys (DEKs) wrapped by a master key (KEK)

### 4.6 Internationalisation (i18n)

- UI strings externalised into `i18n/en.json` from day one
- RTL layout support via CSS logical properties
- Date/time/number formatting via `Intl` API

---

## 5. Data Schemas & Type Contracts

### 5.1 Core TypeScript Interfaces

```typescript
// ── Node ───────────────────────────────────────────────────────
export interface KGNode {
  /** UUID v4 */
  id: string;
  /** Human-readable title */
  label: string;
  /** Taxonomy type */
  type: NodeType;
  /** ISO-8601 timestamp of source creation */
  createdAt: string;
  /** ISO-8601 timestamp of last sync */
  updatedAt: string;
  /** Arbitrary key-value metadata from source connector */
  metadata: Record<string, unknown>;
  /** Source connector identifier */
  sourceId: ConnectorId;
  /** Original source URL or deep-link */
  sourceUrl?: string;
  /** Pre-computed embedding vector (384 dimensions) for semantic search */
  embedding?: number[];
  /** Soft-delete flag */
  deletedAt?: string;
}

export type NodeType =
  | 'person'
  | 'document'
  | 'email'
  | 'event'
  | 'task'
  | 'repository'
  | 'commit'
  | 'issue'
  | 'pull_request'
  | 'bookmark'
  | 'note'
  | 'concept';

// ── Edge ───────────────────────────────────────────────────────
export interface KGEdge {
  /** UUID v4 */
  id: string;
  /** Source node id */
  source: string;
  /** Target node id */
  target: string;
  /** Relationship type (Cypher-style ALL_CAPS) */
  relation: EdgeRelation;
  /** 0–1 weight for layout force calculations */
  weight: number;
  /** Whether this edge was inferred by NLP (vs. explicit) */
  inferred: boolean;
  /** ISO-8601 timestamp */
  createdAt: string;
  metadata: Record<string, unknown>;
}

export type EdgeRelation =
  | 'MENTIONS'
  | 'AUTHORED_BY'
  | 'ASSIGNED_TO'
  | 'RELATED_TO'
  | 'PART_OF'
  | 'LINKS_TO'
  | 'REPLIED_TO'
  | 'TAGGED_WITH'
  | 'SCHEDULED_WITH'
  | 'COMMITS_TO'
  | 'CLOSES'
  | 'REFERENCES';

// ── Connector ──────────────────────────────────────────────────
export type ConnectorId =
  | 'gmail'
  | 'outlook_mail'
  | 'notion'
  | 'obsidian'
  | 'roam'
  | 'github'
  | 'gitlab'
  | 'google_calendar'
  | 'outlook_calendar'
  | 'todoist'
  | 'linear'
  | 'bookmarks';

export interface ConnectorConfig {
  id: ConnectorId;
  userId: string;
  enabled: boolean;
  credentials: EncryptedCredentials;
  syncIntervalMinutes: number;
  lastSyncAt?: string;
  lastSyncStatus?: 'success' | 'partial' | 'failed';
  rateLimitRemaining?: number;
  rateLimitResetsAt?: string;
}

export interface EncryptedCredentials {
  /** AES-256-GCM encrypted token blob (base64) */
  ciphertext: string;
  /** 96-bit IV (base64) */
  iv: string;
  /** Key ID from KEK store */
  keyId: string;
}

// ── Graph Viewport State ───────────────────────────────────────
export interface GraphViewport {
  centerX: number;
  centerY: number;
  zoom: number;
  /** IDs of currently highlighted nodes */
  highlighted: string[];
  /** IDs of selected nodes */
  selected: string[];
  /** Active filter set */
  filters: GraphFilter;
}

export interface GraphFilter {
  nodeTypes: NodeType[];
  connectorIds: ConnectorId[];
  dateRange?: { from: string; to: string };
  searchQuery?: string;
  minEdgeWeight?: number;
}
```

### 5.2 JSON Schema Validation

Every API payload is validated against a compiled Ajv schema derived from the TypeScript interfaces above. Schema files live in `packages/shared/schemas/`.

---

## 6. API Contract

### 6.1 REST Endpoints

All REST routes are prefixed `/api/v1/`. JWT Bearer token required unless marked `[public]`.

| Method | Path | Description | Request Body | Response |
|--------|------|-------------|-------------|----------|
| `POST` | `/auth/login` [public] | Email/password login | `{ email, password }` | `{ accessToken, refreshToken }` |
| `POST` | `/auth/refresh` [public] | Refresh JWT | `{ refreshToken }` | `{ accessToken }` |
| `GET` | `/auth/oauth/:provider/start` | Begin OAuth2 flow | — | Redirect |
| `GET` | `/auth/oauth/:provider/callback` | OAuth2 callback | — | Redirect + set cookies |
| `GET` | `/graph/nodes` | Paginated node list | query: `filter`, `cursor`, `limit` | `{ nodes[], nextCursor }` |
| `GET` | `/graph/nodes/:id` | Single node detail | — | `KGNode` |
| `DELETE` | `/graph/nodes/:id` | Soft-delete node | — | `204` |
| `GET` | `/graph/edges` | Paginated edge list | query: `sourceId`, `targetId`, `relation` | `{ edges[], nextCursor }` |
| `GET` | `/graph/subgraph` | Ego-network subgraph | query: `rootId`, `depth`, `filter` | `{ nodes[], edges[] }` |
| `GET` | `/graph/search` | Full-text node search | query: `q`, `types[]`, `limit` | `{ hits[], query }` |
| `GET` | `/connectors` | List connector configs | — | `ConnectorConfig[]` |
| `PUT` | `/connectors/:id` | Update connector config | `Partial<ConnectorConfig>` | `ConnectorConfig` |
| `POST` | `/connectors/:id/sync` | Trigger manual sync | — | `{ jobId }` |
| `GET` | `/connectors/:id/sync/status` | Sync job status | query: `jobId` | `{ status, progress, errors[] }` |
| `GET` | `/users/me` | Current user profile | — | `UserProfile` |
| `PUT` | `/users/me` | Update profile | `Partial<UserProfile>` | `UserProfile` |
| `DELETE` | `/users/me` | GDPR delete (all data) | — | `202` |
| `GET` | `/audit-log` | Paginated audit log | query: `cursor`, `limit` | `{ events[], nextCursor }` |
| `GET` | `/health` [public] | Liveness probe | — | `{ status: 'ok' }` |
| `GET` | `/health/ready` [public] | Readiness probe | — | `{ status, checks{} }` |

### 6.2 GraphQL Schema (excerpt)

```graphql
type Query {
  node(id: ID!): KGNode
  nodes(filter: NodeFilterInput, first: Int, after: String): NodeConnection!
  subgraph(rootId: ID!, depth: Int = 2, filter: NodeFilterInput): SubgraphPayload!
  search(query: String!, types: [NodeType!], limit: Int = 20): SearchResult!
}

type Mutation {
  deleteNode(id: ID!): Boolean!
  triggerSync(connectorId: ConnectorId!): SyncJob!
  updateConnector(id: ConnectorId!, input: ConnectorUpdateInput!): ConnectorConfig!
}

type Subscription {
  graphUpdated(userId: ID!): GraphDeltaEvent!
  syncProgress(jobId: ID!): SyncProgressEvent!
}

type GraphDeltaEvent {
  type: DeltaType!   # NODES_ADDED | NODES_UPDATED | NODES_DELETED | EDGES_ADDED | EDGES_DELETED
  nodes: [KGNode!]
  edges: [KGEdge!]
  timestamp: String!
}
```

### 6.3 WebSocket Events (Socket.IO)

| Event | Direction | Payload |
|-------|-----------|---------|
| `graph:delta` | Server → Client | `GraphDeltaEvent` |
| `sync:progress` | Server → Client | `{ jobId, connectorId, processed, total, errors[] }` |
| `sync:complete` | Server → Client | `{ jobId, connectorId, nodesAdded, edgesAdded, duration }` |
| `sync:error` | Server → Client | `{ jobId, connectorId, error }` |

---

## 7. Frontend Specification

### 7.1 Page & View Structure

```
/                     → Landing / Auth
/app                  → Main Graph Canvas (authenticated)
/app/timeline         → Timeline View (chronological node list)
/app/connectors       → Connector Settings
/app/settings         → User & App Settings
/app/search           → Full-text Search Results
```

### 7.2 Graph Canvas Component (`<GraphCanvas />`)

**Acceptance Criteria:**
- [ ] AC-F01: Renders all nodes returned by `/graph/subgraph` as force-directed layout within 2.5 s on 1,000-node dataset
- [ ] AC-F02: Node colour encodes `NodeType` via a stable, contrast-compliant 12-colour palette
- [ ] AC-F03: Node size encodes degree (min 4 px, max 24 px radius)
- [ ] AC-F04: Hovering a node shows a tooltip with `label`, `type`, `sourceUrl`, `updatedAt`
- [ ] AC-F05: Clicking a node opens a side-panel with full metadata and outgoing/incoming edges
- [ ] AC-F06: Double-clicking a node re-centres the graph on that node's ego-network (depth-2)
- [ ] AC-F07: Right-click context menu: *Open source*, *Copy link*, *Delete node*, *Expand neighbourhood*
- [ ] AC-F08: Multi-select via Shift+Click; bulk delete via Delete key
- [ ] AC-F09: Filter panel filters nodes/edges live without re-fetching (client-side masking)
- [ ] AC-F10: Zoom: scroll wheel / pinch; Pan: drag canvas
- [ ] AC-F11: "Fit to screen" button (keyboard shortcut `F`)
- [ ] AC-F12: Minimap (collapsible) in bottom-right corner
- [ ] AC-F13: 60 fps @ 5,000 nodes on a 2021-era desktop browser (Chrome 120+)
- [ ] AC-F14: 30 fps @ 5,000 nodes on a mid-range mobile browser (Safari iOS 17+)

### 7.3 Command Palette (`<CommandPalette />`)

- Triggered by `Cmd/Ctrl + K`
- Fuzzy search across node labels, connector names, and app actions
- Keyboard navigable (↑↓ arrows, Enter to select, Esc to close)
- Recent commands persisted in `localStorage`

### 7.4 Timeline View (`<TimelineView />`)

- Virtualized list of nodes sorted by `createdAt` descending
- Date-range picker to zoom into a specific period
- Click a timeline item to highlight the node in the main graph canvas

### 7.5 Mobile Layout

- Bottom-sheet drawer replaces side panel on viewports < 768 px
- Graph canvas occupies full viewport; controls collapse into FAB (Floating Action Button)
- Touch gestures: pinch-to-zoom, two-finger pan, tap to select node

### 7.6 Micro-animations & Polish

- Node entrance: fade-in + scale 0 → 1 over 300 ms (CSS transition)
- Edge entrance: draw-on animation (SVG stroke-dashoffset) over 400 ms
- Side panel: slide-in from right (200 ms ease-out)
- Loading skeleton for graph canvas (shimmer effect)

### 7.7 Keyboard Navigation

| Key | Action |
|-----|--------|
| `Tab` | Focus next node |
| `Shift+Tab` | Focus previous node |
| `Enter` | Open focused node in side panel |
| `F` | Fit graph to screen |
| `Cmd/Ctrl+K` | Open command palette |
| `Escape` | Close side panel / command palette |
| `Delete` | Delete selected node(s) |
| `+` / `-` | Zoom in / out |
| `Arrow keys` | Pan canvas |

---

## 8. Backend Specification

### 8.1 Module Structure (NestJS)

```
src/
├── app.module.ts
├── auth/
│   ├── auth.module.ts
│   ├── jwt.strategy.ts
│   ├── oauth.strategy.ts
│   └── guards/
├── graph/
│   ├── graph.module.ts
│   ├── graph.service.ts        ← business logic
│   ├── graph.repository.ts     ← Neo4j queries
│   ├── graph.resolver.ts       ← GraphQL
│   └── graph.controller.ts     ← REST
├── connectors/
│   ├── connectors.module.ts
│   ├── base.connector.ts       ← abstract class
│   ├── gmail/
│   ├── outlook-mail/
│   ├── notion/
│   ├── obsidian/
│   ├── github/
│   ├── gitlab/
│   ├── google-calendar/
│   ├── outlook-calendar/
│   ├── todoist/
│   ├── linear/
│   └── bookmarks/
├── nlp/
│   ├── nlp.module.ts
│   ├── entity-extractor.service.ts
│   ├── relation-extractor.service.ts
│   └── embedding.service.ts
├── sync/
│   ├── sync.module.ts
│   ├── sync.service.ts
│   └── sync.processor.ts      ← BullMQ processor
├── users/
├── audit/
└── shared/
    ├── crypto/                 ← AES-256-GCM helpers
    ├── neo4j/                  ← Neo4j connection provider
    └── redis/                  ← Redis/BullMQ setup
```

### 8.2 Graph Repository (Neo4j Cypher patterns)

```cypher
// Upsert node
MERGE (n:KGNode {id: $id})
SET n += $properties, n.updatedAt = datetime()
RETURN n

// Ego-network subgraph (depth 2)
MATCH path = (root:KGNode {id: $rootId})-[*1..2]-(neighbour:KGNode)
RETURN root, relationships(path), nodes(path)
LIMIT 500

// Full-text search (requires Neo4j full-text index)
CALL db.index.fulltext.queryNodes('nodeLabels', $query)
YIELD node, score
RETURN node ORDER BY score DESC LIMIT 20
```

---

## 9. Connector Specifications

### 9.1 Base Connector Interface

```typescript
abstract class BaseConnector {
  abstract readonly id: ConnectorId;
  abstract readonly oauthScopes: string[];

  /** Fetch incremental updates since lastSyncAt */
  abstract fetchIncremental(
    config: ConnectorConfig,
    since: Date
  ): AsyncGenerator<RawItem>;

  /** Map raw source item to KGNode + KGEdge[] */
  abstract transform(raw: RawItem): { node: KGNode; edges: KGEdge[] };
}
```

### 9.2 Platform-Specific Details

#### Gmail
- **OAuth scopes:** `https://www.googleapis.com/auth/gmail.readonly`
- **Incremental sync:** `historyId`-based incremental sync (`users.history.list`)
- **Rate limits:** 250 quota units/user/second; implement exponential back-off
- **NLP pipeline:** Subject line + snippet → entity extraction → MENTIONS edges to Person nodes

#### Outlook Mail
- **OAuth scopes:** `Mail.Read`, `offline_access`
- **Incremental sync:** Microsoft Graph delta queries (`/me/messages/delta`)
- **Rate limits:** 10,000 req/10 min per app; throttle via 429 Retry-After header

#### Notion
- **OAuth scopes:** `read_content`, `read_user_without_email`
- **Incremental sync:** Notion Search API filtered by `last_edited_time > lastSyncAt`
- **NLP pipeline:** Page title + block text → entity + relation extraction → `RELATED_TO` edges

#### Obsidian / Roam
- **Import mechanism:** File system watcher on vault directory (self-hosted) or ZIP upload (SaaS)
- **Format:** Markdown with `[[wikilinks]]` → parsed as LINKS_TO edges
- **No OAuth required** (local file access)

#### GitHub
- **OAuth scopes:** `read:user`, `repo` (or `public_repo` for public only)
- **Incremental sync:** GitHub Events API (`/users/{user}/events`) filtered by `created_at`
- **Entities mapped:** Repository, Issue, PullRequest, Commit, User
- **Rate limits:** 5,000 req/hour authenticated; use conditional requests (ETags)

#### GitLab
- **OAuth scopes:** `read_api`, `read_user`
- **Incremental sync:** GitLab Events API with `after` parameter
- **Rate limits:** 2,000 req/min per user

#### Google Calendar
- **OAuth scopes:** `https://www.googleapis.com/auth/calendar.readonly`
- **Incremental sync:** `syncToken`-based incremental sync
- **Entities mapped:** Event → KGNode(type='event'); attendees → Person nodes; `SCHEDULED_WITH` edges

#### Outlook Calendar
- **OAuth scopes:** `Calendars.Read`, `offline_access`
- **Incremental sync:** Microsoft Graph delta queries for calendar events

#### Todoist
- **OAuth scopes:** `data:read`
- **Incremental sync:** Todoist Sync API v9 (`sync_token`)
- **Entities mapped:** Task → KGNode(type='task'); project as `PART_OF` edge

#### Linear
- **OAuth scopes:** `read`
- **Incremental sync:** Linear GraphQL API with `updatedAt_gt` filter
- **Entities mapped:** Issue, Cycle, Project

#### Browser Bookmarks
- **Import:** OPML or Netscape Bookmark File (HTML) upload
- **Parsing:** Title + URL → KGNode(type='bookmark'); domain clustering → `RELATED_TO` edges
- **No live sync;** periodic re-import or browser-extension push (out of scope v1)

### 9.3 NLP Pipeline Stages

```
Raw Text Input
      │
      ▼
1. Language Detection (franc-min)
      │
      ▼
2. Text Normalisation (lowercase, remove HTML, expand contractions)
      │
      ▼
3. Named Entity Recognition (NER)
      │  → People (PER), Organisations (ORG), Locations (LOC), Dates (DATE)
      │
      ▼
4. Key-phrase Extraction (YAKE or KeyBERT-lite)
      │
      ▼
5. Relation Extraction (heuristic patterns + optional LLM call)
      │
      ▼
6. Embedding Generation (all-MiniLM-L6-v2 via @xenova/transformers, 384-dim)
      │
      ▼
7. Graph Write (MERGE nodes + edges in Neo4j)
```

---

## 10. Security & Privacy

### 10.1 Threat Model (STRIDE)

| Threat | Mitigation |
|--------|-----------|
| **Spoofing** — token theft | Short-lived JWTs (15 min) + refresh token rotation; `HttpOnly` / `Secure` / `SameSite=Strict` cookies |
| **Tampering** — graph data mutation | Input validation (Zod/Ajv) on all API routes; signed audit log |
| **Repudiation** — denied actions | Immutable audit log (append-only PostgreSQL table with trigger) |
| **Information Disclosure** — data leak | Row-level security in PostgreSQL; Neo4j per-user label access; encrypted at rest |
| **Denial of Service** — API abuse | Rate limiting (100 req/min/user) via NestJS `@nestjs/throttler`; BullMQ concurrency limits |
| **Elevation of Privilege** — broken auth | RBAC (user / admin); no direct object references (UUIDs); OWASP ASVS Level 2 |

### 10.2 Encryption Details

- **In transit:** TLS 1.3 (NGINX / Caddy termination)
- **At rest — credentials:** AES-256-GCM; per-user Data Encryption Key (DEK) wrapped by a Key Encryption Key (KEK) stored in environment variable or AWS KMS / HashiCorp Vault
- **At rest — graph data:** PostgreSQL Transparent Data Encryption (TDE) or filesystem encryption
- **Key rotation:** DEKs rotatable without re-encrypting data (re-wrap only)

### 10.3 GDPR Compliance

- `DELETE /users/me` triggers cascading deletion of all user data across PostgreSQL and Neo4j within 30 days (immediate for credentials)
- Data export (`GET /users/me/export`) generates a JSON archive of all nodes and edges within 72 hours
- Consent banner on first login; consent record stored with timestamp

### 10.4 Audit Logging

Every mutation (node/edge create/update/delete, connector enable/disable, login, data export) is recorded to `audit_events` table:

```sql
CREATE TABLE audit_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  action      TEXT NOT NULL,
  resource    TEXT,
  resource_id TEXT,
  metadata    JSONB,
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Append-only: no UPDATE/DELETE allowed via row-level policy
```

---

## 11. Testing Strategy

### 11.1 Coverage Requirements

| Layer | Minimum Coverage |
|-------|-----------------|
| Domain / Use-case logic | 90% line coverage |
| API controllers / resolvers | 85% line coverage |
| Connector transforms | 95% line coverage |
| Frontend components | 80% line coverage |
| E2E critical paths | 100% of listed user journeys |

### 11.2 Test Types

**Unit tests** (Jest / Vitest)
- Pure functions, domain entities, connector `transform()` methods
- Mock all I/O (Neo4j, Redis, external APIs)

**Integration tests** (Jest + Testcontainers)
- Repository layer against a real Neo4j instance (Docker)
- Sync pipeline against mocked OAuth provider responses

**E2E tests** (Playwright)
- Critical user journeys (see below)
- Run against `docker compose up` local stack

**Mutation testing** (Stryker)
- Applied to domain layer and connector transforms
- Target mutation score ≥ 70%

### 11.3 Critical E2E User Journeys

1. Sign up → connect GitHub → trigger sync → view GitHub repos as graph nodes
2. Search for a node by label → click result → open side panel → see edges
3. Filter graph by node type `email` → confirm only email nodes visible
4. Delete a node → confirm it disappears from canvas + not returned by API
5. GDPR export → receive JSON file with all user nodes and edges
6. Keyboard-only navigation: Tab through nodes → Enter to open → Escape to close

### 11.4 Performance Tests (k6)

- Ramp to 200 concurrent users over 5 minutes
- Sustain for 10 minutes
- Target: p95 API latency < 200 ms, error rate < 0.1%

---

## 12. Implementation Roadmap (8 Phases)

### Phase 0 — Foundation (Week 1–2)

**Definition of Done (DoD):**
- [ ] Monorepo scaffold (`pnpm workspaces`): `apps/web`, `apps/api`, `packages/shared`
- [ ] Docker Compose with Neo4j, PostgreSQL, Redis, Meilisearch
- [ ] `docker compose up` brings up all services with seed data
- [ ] CI pipeline: lint + type-check + unit tests pass on every PR
- [ ] Shared TypeScript interfaces + JSON schemas published from `packages/shared`
- [ ] README with local dev setup instructions

### Phase 1 — Auth & User Management (Week 3)

**DoD:**
- [ ] JWT authentication (login, refresh, logout)
- [ ] OAuth2 integration scaffold (provider-agnostic)
- [ ] User table in PostgreSQL; profile CRUD
- [ ] Audit log table + middleware wired
- [ ] Unit tests: 90% coverage on auth module

### Phase 2 — Graph Core (Week 4–5)

**DoD:**
- [ ] Neo4j connection provider + repository pattern
- [ ] REST + GraphQL endpoints for nodes/edges/subgraph
- [ ] Meilisearch node indexing + search endpoint
- [ ] WebSocket gateway (Socket.IO) for `graph:delta` events
- [ ] Unit + integration tests for graph repository

### Phase 3 — Frontend Canvas (Week 6–7)

**DoD:**
- [ ] `<GraphCanvas />` rendering nodes from API with force-directed layout
- [ ] Node colouring, sizing, tooltip, side panel
- [ ] Filter panel (client-side masking)
- [ ] Keyboard navigation (all shortcuts in §7.7)
- [ ] Command palette
- [ ] All AC-F01 through AC-F14 pass (manual + automated checks)
- [ ] Lighthouse Performance ≥ 95

### Phase 4 — Connector: GitHub (Week 8)

**DoD:**
- [ ] GitHub OAuth2 flow complete
- [ ] Incremental sync via Events API
- [ ] Connector transform unit tests: 95% coverage
- [ ] E2E journey 1 passes (connect GitHub → view repos in graph)

### Phase 5 — Connectors: Gmail + Google Calendar (Week 9)

**DoD:**
- [ ] Gmail OAuth2 + incremental sync (`historyId`)
- [ ] Google Calendar OAuth2 + incremental sync (`syncToken`)
- [ ] NLP pipeline stages 1–5 operational
- [ ] Rate-limit handling with exponential back-off

### Phase 6 — Connectors: Notion + Obsidian + Bookmarks (Week 10)

**DoD:**
- [ ] Notion OAuth2 + incremental sync
- [ ] Obsidian ZIP upload + wikilink parsing
- [ ] Bookmark OPML/HTML import
- [ ] Embedding generation (stage 6 of NLP pipeline) wired to Neo4j nodes

### Phase 7 — Connectors: Outlook, Todoist, Linear, GitLab (Week 11)

**DoD:**
- [ ] All four connectors implemented and tested
- [ ] All connector unit tests: 95% coverage
- [ ] Sync status dashboard in UI (progress bars, error messages)

### Phase 8 — Hardening, Accessibility & Launch (Week 12)

**DoD:**
- [ ] WCAG 2.2 AA audit passes (axe-core + manual screen-reader test)
- [ ] GDPR delete + export endpoints tested with E2E tests
- [ ] k6 load test passes (p95 < 200 ms @ 200 concurrent users)
- [ ] Security review: OWASP Top 10 checklist complete
- [ ] Mutation score ≥ 70% on domain layer
- [ ] All 6 E2E user journeys green
- [ ] `docker compose up --build` produces fully working stack with seed data
- [ ] Architecture Decision Records (ADRs) written for all major choices
- [ ] API documentation auto-generated (Swagger UI + GraphQL Playground)

---

## 13. DevOps & Observability

### 13.1 Docker Compose (local dev)

```yaml
# docker-compose.yml (abbreviated)
services:
  api:
    build: ./apps/api
    environment:
      NEO4J_URI: bolt://neo4j:7687
      POSTGRES_URL: postgresql://pkg:pkg@postgres:5432/pkg
      REDIS_URL: redis://redis:6379
    ports: ["3001:3001"]
    depends_on: [neo4j, postgres, redis, meilisearch]

  web:
    build: ./apps/web
    ports: ["3000:3000"]
    environment:
      NEXT_PUBLIC_API_URL: http://localhost:3001

  neo4j:
    image: neo4j:5
    environment:
      NEO4J_AUTH: neo4j/password
    volumes: ["neo4j_data:/data"]

  postgres:
    image: postgres:15
    environment:
      POSTGRES_USER: pkg
      POSTGRES_PASSWORD: pkg
      POSTGRES_DB: pkg
    volumes: ["postgres_data:/var/lib/postgresql/data"]

  redis:
    image: redis:7-alpine
    volumes: ["redis_data:/data"]

  meilisearch:
    image: getmeili/meilisearch:latest
    volumes: ["meili_data:/meili_data"]
```

### 13.2 CI/CD (GitHub Actions)

```yaml
# .github/workflows/ci.yml
on: [push, pull_request]
jobs:
  lint-and-type-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - run: pnpm install --frozen-lockfile
      - run: pnpm run lint
      - run: pnpm run type-check

  test:
    runs-on: ubuntu-latest
    services:
      neo4j: { image: neo4j:5, ... }
      postgres: { image: postgres:15, ... }
      redis: { image: redis:7, ... }
    steps:
      - run: pnpm test --coverage

  e2e:
    runs-on: ubuntu-latest
    steps:
      - run: docker compose up -d --build
      - run: pnpm run test:e2e
```

### 13.3 Observability Stack

| Tool | Purpose |
|------|---------|
| Prometheus | Metrics scraping (NestJS `/metrics` endpoint via `prom-client`) |
| Grafana | Dashboards: API latency, sync job throughput, error rates |
| OpenTelemetry | Distributed tracing (spans across API → Neo4j → Connector) |
| Loki | Log aggregation from Docker containers |
| BullMQ Board | Visual queue monitoring (`@bull-board/express`) |

### 13.4 Health Checks

- `GET /health` → liveness (process alive)
- `GET /health/ready` → readiness: checks Neo4j, PostgreSQL, Redis connectivity

---

## 14. AI Agent Instructions (25 Rules)

The following rules MUST be followed by any AI coding agent implementing this specification:

1. **Strict TypeScript:** `"strict": true` in all `tsconfig.json` files. Zero `any` types. Use `unknown` and narrow with type guards.
2. **Test-Driven Development (TDD):** Write failing tests first for every new function, service, or component. Tests must pass before moving to the next feature.
3. **Clean Architecture:** No imports from outer layers into inner layers. Domain layer has zero framework dependencies.
4. **Feature flags:** Wrap each new connector behind a feature flag (`FEATURE_CONNECTOR_GITHUB=true`) so connectors can be shipped independently.
5. **Zero secrets in source:** All credentials, API keys, and tokens must come from environment variables. Use `zod` to validate all env vars at startup.
6. **ADRs for every major decision:** Create an Architecture Decision Record (`docs/adr/NNN-title.md`) for every significant technical choice.
7. **OpenAPI first:** Define the REST contract in `openapi.yaml` before implementing. Generate client types from it.
8. **Error handling:** All async functions return `Result<T, E>` (neverthrow) or use structured error classes. No raw `throw` in business logic.
9. **Observability:** Every background job emits start/complete/error log events with structured JSON fields (`jobId`, `connectorId`, `duration`, `error`).
10. **Dependency injection everywhere:** Use NestJS DI for all services; no module-level singletons.
11. **Database migrations:** Use `db-migrate` or `typeorm` migrations; never modify the DB schema manually.
12. **Idempotent syncs:** Every connector sync must be safe to run multiple times without creating duplicate nodes/edges (use `MERGE` in Cypher).
13. **Rate-limit respect:** All connector API clients must honour `Retry-After` headers and implement exponential back-off with jitter.
14. **Accessibility first:** Every new React component must include `aria-*` attributes and a Storybook story with axe-core accessibility check.
15. **Component isolation:** Every React component is a pure function with no side effects; data fetching happens in hooks or server components only.
16. **No over-fetching:** GraphQL queries must use field selection; REST responses must use sparse fieldsets where supported.
17. **Pagination everywhere:** No endpoint returns unbounded lists. Cursor-based pagination for all list endpoints.
18. **Immutable audit log:** The `audit_events` table has a PostgreSQL row-level security policy preventing UPDATE and DELETE.
19. **GDPR delete completeness:** Verify all data stores (Neo4j, PostgreSQL, Redis, Meilisearch, S3) are purged on `DELETE /users/me`.
20. **Docker-first local dev:** `docker compose up --build` must produce a fully functional stack with seed data on a clean machine.
21. **Lighthouse CI:** Every frontend PR must pass Lighthouse CI with Performance ≥ 95, Accessibility ≥ 95, Best Practices ≥ 95.
22. **Bundle budget:** Frontend JS bundle (gzipped) must not exceed 500 KB for initial load. Use `bundlephobia` or webpack-bundle-analyzer.
23. **Mutation testing:** Run Stryker on the domain layer and connector transforms; fail CI if mutation score drops below 70%.
24. **i18n from day one:** All user-facing strings are referenced from `i18n/en.json`; no hard-coded strings in JSX.
25. **Ethical AI guard:** The NLP pipeline must not store raw email/document content permanently. Only extracted entities and relations are persisted.

---

## 15. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| OAuth scope changes by provider | Medium | High | Abstract provider details behind connector interface; monitor provider changelogs |
| Neo4j performance at 50k+ nodes | Medium | High | Test early with synthetic dataset; add indexes; consider graph partitioning |
| NLP accuracy for entity extraction | High | Medium | Provide manual correction UI; store confidence scores; allow user to override edges |
| Rate limiting from email providers | High | Medium | Exponential back-off; queue-based throttling; user-configurable sync intervals |
| GDPR non-compliance (missed data store) | Low | Critical | Integration test for delete completeness; legal review before EU launch |
| Browser performance on large graphs | Medium | High | Implement LOD (Level of Detail) rendering; cluster nodes beyond zoom threshold |
| Dependency abandonment (react-force-graph) | Low | Medium | Abstraction layer (`<GraphRenderer />`) allows swapping renderer |
| Credential theft from database breach | Low | Critical | Per-user DEK encryption; short-lived tokens; breach notification procedure |

---

## 16. Appendices

### Appendix A — Glossary

| Term | Definition |
|------|-----------|
| **DEK** | Data Encryption Key — a per-user AES-256-GCM key used to encrypt connector credentials |
| **KEK** | Key Encryption Key — a master key (in environment or KMS) that wraps all DEKs |
| **Ego-network** | The subgraph formed by a node and all nodes reachable within N hops |
| **NER** | Named Entity Recognition — NLP technique to extract named persons, organisations, dates, etc. |
| **LOD** | Level of Detail — technique to render simplified geometry at low zoom levels for performance |
| **ASVS** | OWASP Application Security Verification Standard |
| **OPML** | Outline Processor Markup Language — common format for bookmark/feed exports |
| **ADR** | Architecture Decision Record — a document capturing the context and outcome of a significant design decision |
| **BullMQ** | Redis-backed job queue library for Node.js |
| **TTI** | Time to Interactive — Lighthouse metric measuring when the page becomes reliably interactive |

### Appendix B — Sample Mock Data Generator

```typescript
// packages/shared/src/mocks/generate-seed-data.ts
import { faker } from '@faker-js/faker';
import type { KGNode, KGEdge, NodeType } from '../types';

const NODE_TYPES: NodeType[] = [
  'person', 'document', 'email', 'event', 'task',
  'repository', 'commit', 'issue', 'bookmark', 'note'
];

export function generateNodes(count: number): KGNode[] {
  return Array.from({ length: count }, () => ({
    id: faker.string.uuid(),
    label: faker.lorem.words({ min: 1, max: 5 }),
    type: faker.helpers.arrayElement(NODE_TYPES),
    createdAt: faker.date.past({ years: 2 }).toISOString(),
    updatedAt: faker.date.recent({ days: 30 }).toISOString(),
    metadata: {},
    sourceId: 'github',
    sourceUrl: faker.internet.url(),
  }));
}

export function generateEdges(nodes: KGNode[], density = 0.05): KGEdge[] {
  const edges: KGEdge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (Math.random() < density) {
        edges.push({
          id: faker.string.uuid(),
          source: nodes[i].id,
          target: nodes[j].id,
          relation: 'RELATED_TO',
          weight: Math.random(),
          inferred: true,
          createdAt: faker.date.recent({ days: 30 }).toISOString(),
          metadata: {},
        });
      }
    }
  }
  return edges;
}
```

### Appendix C — Architecture Decision Records (Index)

ADRs to be written during Phase 0 and updated throughout:

| ADR | Title |
|-----|-------|
| ADR-001 | Monorepo structure with pnpm workspaces |
| ADR-002 | NestJS over plain Express for API layer |
| ADR-003 | Neo4j as primary graph store |
| ADR-004 | react-force-graph-2d as primary renderer |
| ADR-005 | BullMQ over Agenda/node-cron for sync scheduling |
| ADR-006 | AES-256-GCM with per-user DEKs for credential encryption |
| ADR-007 | Cursor-based pagination over offset pagination |
| ADR-008 | Zustand over Redux for frontend state |
| ADR-009 | Meilisearch over Elasticsearch for node full-text search |
| ADR-010 | all-MiniLM-L6-v2 (in-process) over OpenAI embeddings API |

### Appendix D — Mermaid Diagram Descriptions

#### D.1 C4 Context Diagram

```mermaid
C4Context
  title System Context — Personal Knowledge Graph Visualization System
  Person(user, "User", "Knowledge worker, researcher, or developer")
  System(pkgvs, "PKG-VS", "Personal Knowledge Graph Visualization System")
  System_Ext(google, "Google APIs", "Gmail, Google Calendar")
  System_Ext(microsoft, "Microsoft Graph", "Outlook Mail, Outlook Calendar")
  System_Ext(github, "GitHub API", "Repositories, Issues, PRs")
  System_Ext(notion, "Notion API", "Pages, Databases")
  System_Ext(todoist, "Todoist API", "Tasks")
  System_Ext(linear, "Linear API", "Issues, Cycles")
  Rel(user, pkgvs, "Uses", "HTTPS")
  Rel(pkgvs, google, "Fetches data", "OAuth2 / REST")
  Rel(pkgvs, microsoft, "Fetches data", "OAuth2 / REST")
  Rel(pkgvs, github, "Fetches data", "OAuth2 / REST")
  Rel(pkgvs, notion, "Fetches data", "OAuth2 / REST")
  Rel(pkgvs, todoist, "Fetches data", "OAuth2 / REST")
  Rel(pkgvs, linear, "Fetches data", "OAuth2 / REST")
```

#### D.2 ERD (PostgreSQL tables)

```mermaid
erDiagram
  USERS {
    uuid id PK
    text email UK
    text password_hash
    text display_name
    timestamptz created_at
    timestamptz deleted_at
  }
  CONNECTOR_CONFIGS {
    uuid id PK
    uuid user_id FK
    text connector_id
    boolean enabled
    text credentials_ciphertext
    text credentials_iv
    text key_id
    int sync_interval_minutes
    timestamptz last_sync_at
    text last_sync_status
  }
  AUDIT_EVENTS {
    uuid id PK
    uuid user_id FK
    text action
    text resource
    text resource_id
    jsonb metadata
    inet ip_address
    timestamptz created_at
  }
  USERS ||--o{ CONNECTOR_CONFIGS : "has"
  USERS ||--o{ AUDIT_EVENTS : "generates"
```

#### D.3 Sync Sequence Diagram

```mermaid
sequenceDiagram
  participant UI
  participant API
  participant Queue as BullMQ Queue
  participant Worker as Sync Worker
  participant Connector as Platform API
  participant Neo4j

  UI->>API: POST /connectors/github/sync
  API->>Queue: enqueue(syncJob)
  API-->>UI: { jobId }
  Queue->>Worker: dequeue(syncJob)
  Worker->>Connector: fetchIncremental(since)
  Connector-->>Worker: RawItem[]
  Worker->>Worker: transform(rawItems) → nodes + edges
  Worker->>Neo4j: MERGE nodes + edges (Cypher)
  Worker->>API: emit graph:delta via Socket.IO
  API-->>UI: graph:delta event (WebSocket)
  UI->>UI: update graph canvas
```

### Appendix E — i18n & Offline Support Notes

**i18n:**
- Use `react-i18next` + `i18next-browser-languagedetector`
- Translation files: `apps/web/public/locales/{lang}/translation.json`
- Default locale: `en`; provide translations for `es`, `fr`, `de`, `ja` in Phase 8

**Offline support:**
- Service worker (Workbox) caches the last-loaded graph snapshot
- If offline, graph canvas loads from cache with a visual "offline" badge
- Mutations (delete node) are queued locally and synced on reconnect (background sync API)

---

*End of Enhanced Personal Knowledge Graph Visualization System Specification v2.0*
*Document generated: 2026-04-25 | 1129 lines | ~44 KB*
