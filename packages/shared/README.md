# @pkg/shared

Single source of truth for cross-app types in PKG-VS — mirrors **§5 Data Schemas & Type Contracts** of the v2.0 spec.

## What's in here

| Module                        | Purpose                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| `src/types.ts`                | TypeScript interfaces (`KGNode`, `KGEdge`, `ConnectorConfig`, …) |
| `src/schemas.ts`              | `zod` runtime validators (1-to-1 with `types.ts`)             |
| `src/mocks/`                  | Spec Appendix B mock generators (`generateNodes`, `generateGraph`) |

## Usage

```ts
import { KGNodeSchema, generateGraph } from '@pkg/shared';

const { nodes, edges } = generateGraph(200, 0.02, { seed: 42 });
KGNodeSchema.parse(nodes[0]); // throws on invalid shape
```

## Drift discipline

Whenever §5 of the spec changes, edit `types.ts` **and** `schemas.ts` together — divergence is a high-priority bug. The unit tests in `__tests__/types.test.ts` round-trip `Mocks → Schema` to catch drift early.
