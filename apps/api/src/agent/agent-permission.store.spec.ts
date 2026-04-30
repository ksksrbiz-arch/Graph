import { BadRequestException } from '@nestjs/common';
import { AgentPermissionStore, validateScope } from './agent-permission.store';

describe('AgentPermissionStore', () => {
  it('denies by default', () => {
    const store = new AgentPermissionStore();
    expect(store.has('u1', 'agent:enact-motor')).toBe(false);
  });

  it('grants and reflects via has() and list()', () => {
    const store = new AgentPermissionStore();
    store.grant('u1', 'agent:enact-motor');
    expect(store.has('u1', 'agent:enact-motor')).toBe(true);
    expect(store.list('u1')).toHaveLength(1);
  });

  it('revokes a previously-granted scope', () => {
    const store = new AgentPermissionStore();
    store.grant('u1', 'agent:enact-motor');
    expect(store.revoke('u1', 'agent:enact-motor')).toBe(true);
    expect(store.has('u1', 'agent:enact-motor')).toBe(false);
  });

  it('expires grants past their expiresAt', () => {
    const store = new AgentPermissionStore();
    store.grant('u1', 'agent:enact-motor', { expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(store.has('u1', 'agent:enact-motor')).toBe(false);
    expect(store.list('u1')).toHaveLength(0);
  });

  it('matches `agent:ingest:gmail` against a wildcard `agent:ingest:*` grant', () => {
    const store = new AgentPermissionStore();
    store.grant('u1', 'agent:ingest:*');
    expect(store.has('u1', 'agent:ingest:gmail')).toBe(true);
    expect(store.has('u1', 'agent:ingest:notion')).toBe(true);
    expect(store.has('u1', 'agent:enact-motor')).toBe(false);
  });

  it('isolates grants between users', () => {
    const store = new AgentPermissionStore();
    store.grant('u1', 'agent:enact-motor');
    expect(store.has('u2', 'agent:enact-motor')).toBe(false);
  });

  it('rejects malformed scopes via grant()', () => {
    const store = new AgentPermissionStore();
    expect(() => store.grant('u1', 'agent:not-a-real-scope' as never))
      .toThrow(BadRequestException);
    expect(() => store.grant('u1', 'agent:ingest:' as never))
      .toThrow(BadRequestException);
    expect(() => store.grant('u1', 'agent:ingest:bad/path' as never))
      .toThrow(BadRequestException);
  });

  it('rejects malformed expiresAt timestamps', () => {
    const store = new AgentPermissionStore();
    expect(() => store.grant('u1', 'agent:enact-motor', { expiresAt: 'not-a-date' }))
      .toThrow(BadRequestException);
  });

  it('rejects empty userId', () => {
    const store = new AgentPermissionStore();
    expect(() => store.grant('', 'agent:enact-motor')).toThrow(BadRequestException);
  });
});

describe('validateScope', () => {
  it('accepts every fixed scope', () => {
    expect(validateScope('agent:enact-motor')).toBe('agent:enact-motor');
    expect(validateScope('agent:investigate')).toBe('agent:investigate');
    expect(validateScope('agent:predict-links')).toBe('agent:predict-links');
    expect(validateScope('agent:propose-edge')).toBe('agent:propose-edge');
  });

  it('accepts ingest scopes with valid targets', () => {
    expect(validateScope('agent:ingest:gmail')).toBe('agent:ingest:gmail');
    expect(validateScope('agent:ingest:*')).toBe('agent:ingest:*');
    expect(validateScope('agent:ingest:google_calendar')).toBe('agent:ingest:google_calendar');
  });

  it('rejects unknown top-level scopes', () => {
    expect(() => validateScope('admin:root')).toThrow(BadRequestException);
    expect(() => validateScope('agent:hijack')).toThrow(BadRequestException);
  });

  it('rejects ingest scopes with bad target chars', () => {
    expect(() => validateScope('agent:ingest:..')).toThrow(BadRequestException);
    expect(() => validateScope('agent:ingest:a/b')).toThrow(BadRequestException);
    expect(() => validateScope('agent:ingest:UPPER')).toThrow(BadRequestException);
  });

  it('rejects non-string and oversize inputs', () => {
    expect(() => validateScope('')).toThrow(BadRequestException);
    expect(() => validateScope('a'.repeat(300))).toThrow(BadRequestException);
    expect(() => validateScope(undefined as unknown as string)).toThrow(BadRequestException);
  });
});
