import { AgentPermissionStore } from './agent-permission.store';

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
});
