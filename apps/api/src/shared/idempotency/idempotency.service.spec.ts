import {
  IdempotencyConflictError,
  IdempotencyService,
  fingerprintOf,
} from './idempotency.service';

describe('IdempotencyService', () => {
  let svc: IdempotencyService;

  beforeEach(() => {
    svc = new IdempotencyService();
  });

  afterEach(() => {
    svc.onModuleDestroy();
  });

  it('runs fn once per (scope, key) and returns the cached value on replay', async () => {
    const fn = jest.fn().mockResolvedValue({ ok: 1 });
    const a = await svc.withKey('user-1:test', 'k1', fn);
    const b = await svc.withKey('user-1:test', 'k1', fn);
    expect(a).toEqual({ ok: 1 });
    expect(b).toEqual({ ok: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('isolates keys across scopes', async () => {
    const fn = jest.fn().mockImplementation(() => Promise.resolve(Math.random()));
    const a = await svc.withKey('user-1:test', 'k', fn);
    const b = await svc.withKey('user-2:test', 'k', fn);
    expect(a).not.toBe(b);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent duplicates onto a single in-flight Promise', async () => {
    let calls = 0;
    const fn = (): Promise<number> =>
      new Promise((resolve) => {
        calls += 1;
        setTimeout(() => resolve(42), 10);
      });
    const [a, b, c] = await Promise.all([
      svc.withKey('s', 'k', fn),
      svc.withKey('s', 'k', fn),
      svc.withKey('s', 'k', fn),
    ]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(c).toBe(42);
    expect(calls).toBe(1);
  });

  it('does not cache failures — caller may retry', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('ok');
    await expect(svc.withKey('s', 'k', fn)).rejects.toThrow('boom');
    await expect(svc.withKey('s', 'k', fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws IdempotencyConflictError when the same key is reused with a different payload', async () => {
    await svc.withKey('s', 'k', () => Promise.resolve(1), {
      payload: { v: 'A' },
    });
    await expect(
      svc.withKey('s', 'k', () => Promise.resolve(2), { payload: { v: 'B' } }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('returns the cached value when the same key is reused with the same payload', async () => {
    const a = await svc.withKey('s', 'k', () => Promise.resolve('first'), {
      payload: { v: 1, w: 2 },
    });
    const b = await svc.withKey('s', 'k', () => Promise.resolve('second'), {
      // same content, different key order — should still match.
      payload: { w: 2, v: 1 },
    });
    expect(a).toBe('first');
    expect(b).toBe('first');
  });

  it('expires entries after the configured TTL', async () => {
    const fn = jest
      .fn()
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('second');
    const a = await svc.withKey('s', 'k', fn, { ttlMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    const b = await svc.withKey('s', 'k', fn, { ttlMs: 5 });
    expect(a).toBe('first');
    expect(b).toBe('second');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('forget() drops a single entry', async () => {
    await svc.withKey('s', 'k', () => Promise.resolve(1));
    expect(svc.has('s', 'k')).toBe(true);
    expect(svc.forget('s', 'k')).toBe(true);
    expect(svc.has('s', 'k')).toBe(false);
  });

  it('forgetScope() drops every entry for a scope', async () => {
    await svc.withKey('user-1:test', 'k1', () => Promise.resolve(1));
    await svc.withKey('user-1:test', 'k2', () => Promise.resolve(2));
    await svc.withKey('user-2:test', 'k1', () => Promise.resolve(3));
    expect(svc.forgetScope('user-1:test')).toBe(2);
    expect(svc.has('user-1:test', 'k1')).toBe(false);
    expect(svc.has('user-2:test', 'k1')).toBe(true);
  });
});

describe('fingerprintOf', () => {
  it('is stable across key orderings', () => {
    expect(fingerprintOf({ a: 1, b: 2 })).toBe(fingerprintOf({ b: 2, a: 1 }));
  });

  it('distinguishes different values', () => {
    expect(fingerprintOf({ a: 1 })).not.toBe(fingerprintOf({ a: 2 }));
  });

  it('handles primitives', () => {
    expect(fingerprintOf(null)).toBe(fingerprintOf(null));
    expect(fingerprintOf('x')).not.toBe(fingerprintOf('y'));
  });

  it('handles nested arrays and objects', () => {
    const a = { items: [{ x: 1 }, { x: 2 }] };
    const b = { items: [{ x: 1 }, { x: 2 }] };
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });
});
