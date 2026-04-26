# ADR-005: BullMQ for sync scheduling

- Status: accepted
- Date: 2026-04-26
- Phase: 0

## Context

Connector syncs need: scheduled jobs (every N minutes), manual triggers from the UI, retries with exponential back-off, distributed worker support, and observability. Options weighed: `node-cron`, `Agenda` (MongoDB-backed), `BullMQ` (Redis-backed).

## Decision

BullMQ. We already have Redis in the stack for caching and pub-sub; piggy-backing on it avoids introducing MongoDB just for jobs. BullMQ's API supports per-connector queues, rate-limited workers, and `@bull-board/express` dashboard out of the box.

## Consequences

- Redis becomes a critical dependency for sync; readiness probe (§13.4) checks it.
- One queue per connector (e.g. `sync:github`) keeps backpressure isolated and simplifies rate-limit handling (Rule 13).
