import { KGNodeSchema } from '@pkg/shared';
import { deterministicUuid, readRateLimit } from './connector-utils';

describe('deterministicUuid', () => {
  it('produces the same id for the same (connector, externalId) pair', () => {
    const a = deterministicUuid('github', 'commit:foo/bar:abc');
    const b = deterministicUuid('github', 'commit:foo/bar:abc');
    expect(a).toBe(b);
  });

  it('passes the zod uuid validator used by KGNodeSchema', () => {
    const id = deterministicUuid('github', 'issue:foo/bar:42');
    const result = KGNodeSchema.safeParse({
      id,
      label: 'an issue',
      type: 'issue',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      metadata: {},
      sourceId: 'github',
    });
    expect(result.success).toBe(true);
  });

  it('produces different ids for different externalIds', () => {
    const a = deterministicUuid('github', 'a');
    const b = deterministicUuid('github', 'b');
    expect(a).not.toBe(b);
  });
});

describe('readRateLimit', () => {
  it('parses GitHub-style x-ratelimit headers', () => {
    const epoch = Math.floor(Date.now() / 1000) + 60;
    const res = new Response(null, {
      headers: {
        'x-ratelimit-remaining': '42',
        'x-ratelimit-reset': String(epoch),
      },
    });
    const snap = readRateLimit(res);
    expect(snap.remaining).toBe(42);
    expect(snap.resetsAt && Date.parse(snap.resetsAt)).toBeCloseTo(
      epoch * 1000,
      -3,
    );
  });

  it('falls back to retry-after when no x-ratelimit headers are present', () => {
    const res = new Response(null, { headers: { 'retry-after': '5' } });
    const snap = readRateLimit(res);
    expect(snap.remaining).toBeUndefined();
    expect(snap.resetsAt).toBeTruthy();
  });
});
