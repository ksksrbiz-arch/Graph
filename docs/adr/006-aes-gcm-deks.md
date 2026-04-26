# ADR-006: AES-256-GCM with per-user DEKs for credentials

- Status: accepted
- Date: 2026-04-26
- Phase: 0

## Context

Connector OAuth tokens (Gmail, GitHub, …) are highly sensitive. Spec §10.2 requires AES-256-GCM at rest and per-user encryption keys.

## Decision

Two-tier key hierarchy:

- **KEK (Key Encryption Key):** 32 random bytes, base64 in `KEK_BASE64` env var (in production, sourced from AWS KMS / HashiCorp Vault).
- **DEK (Data Encryption Key):** per-user, generated on first login, wrapped with KEK, stored alongside the user row.

Phase 0 ships a single-tier implementation (KEK directly encrypts tokens) — `keyId='kek-v1'`. Phase 1 adds DEKs without breaking the wire format because `EncryptedCredentials` already carries `keyId`.

Cipher: AES-256-GCM with 96-bit IV (NIST SP-800-38D §8.2.1) and 128-bit auth tag. IVs are random per encryption (never reused with the same key).

## Consequences

- Key rotation: re-wrap DEKs without touching ciphertext — zero downtime.
- A KEK compromise allows decrypting all DEKs (and therefore all tokens). Mitigation: KEK lives in KMS in production; access is audited.
- IV reuse would be catastrophic for GCM — `randomBytes(12)` per call is non-negotiable, enforced by tests (`uses a fresh IV for each call`).
