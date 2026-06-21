// Unit tests for ApprovalQueueService — all Postgres calls are mocked via a
// fake Pool (no real database).

import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { POSTGRES_POOL } from '../shared/postgres/postgres.module';
import { ApprovalQueueService } from './approval-queue.service';
import type { MotorIntent } from './safety-supervisor';

function mockPool(rows: Record<string, unknown>[] = []) {
  return { query: jest.fn().mockResolvedValue({ rows }) };
}

async function makeService(pool = mockPool()) {
  const mod = await Test.createTestingModule({
    providers: [
      ApprovalQueueService,
      { provide: POSTGRES_POOL, useValue: pool },
    ],
  }).compile();
  return { service: mod.get(ApprovalQueueService), pool };
}

const createdAt = new Date('2026-06-21T00:00:00.000Z');

const dbRow = {
  id: 'action-1',
  user_id: 'user-1',
  action: 'send_email',
  payload: { to: 'bob@example.com' },
  neuron_id: 'n-7',
  confidence: 0.9,
  status: 'pending',
  decided_by: null,
  decision_note: null,
  created_at: createdAt,
  decided_at: null,
};

function intent(overrides: Partial<MotorIntent> = {}): MotorIntent {
  return {
    action: 'send_email',
    payload: { to: 'bob@example.com' },
    neuronId: 'n-7',
    confidence: 0.9,
    ...overrides,
  };
}

describe('ApprovalQueueService.enqueue', () => {
  it('inserts a pending action and maps the row to a domain object', async () => {
    const pool = mockPool([dbRow]);
    const { service } = await makeService(pool);
    const action = await service.enqueue('user-1', intent());
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO pending_motor_actions'),
      ['user-1', 'send_email', JSON.stringify({ to: 'bob@example.com' }), 'n-7', 0.9],
    );
    expect(action.id).toBe('action-1');
    expect(action.status).toBe('pending');
    expect(action.payload).toEqual({ to: 'bob@example.com' });
    expect(action.createdAt).toBe(createdAt.toISOString());
    expect(action.decidedAt).toBeNull();
  });

  it('serializes a null/undefined payload and neuronId safely', async () => {
    const pool = mockPool([{ ...dbRow, payload: {}, neuron_id: null }]);
    const { service } = await makeService(pool);
    await service.enqueue('user-1', {
      action: 'commit_changes',
      payload: undefined as unknown as Record<string, unknown>,
      neuronId: undefined as unknown as string,
      confidence: 0.5,
    });
    const args = (pool.query as jest.Mock).mock.calls[0][1] as unknown[];
    expect(args[2]).toBe(JSON.stringify({}));
    expect(args[3]).toBeNull();
  });
});

describe('ApprovalQueueService.listPending', () => {
  it('queries only pending rows for the user and maps them', async () => {
    const pool = mockPool([dbRow]);
    const { service } = await makeService(pool);
    const list = await service.listPending('user-1');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'pending'"),
      ['user-1', 50],
    );
    expect(list).toHaveLength(1);
    expect(list[0].action).toBe('send_email');
  });

  it('honours a custom limit', async () => {
    const { service, pool } = await makeService(mockPool([]));
    await service.listPending('user-1', 10);
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), ['user-1', 10]);
  });

  it('returns an empty array when nothing is pending', async () => {
    const { service } = await makeService(mockPool([]));
    expect(await service.listPending('user-1')).toEqual([]);
  });
});

describe('ApprovalQueueService.decide', () => {
  it('approves a pending action and records the decision', async () => {
    const approved = {
      ...dbRow,
      status: 'approved',
      decided_by: 'user-1',
      decision_note: 'ok',
      decided_at: new Date('2026-06-21T01:00:00.000Z'),
    };
    const pool = mockPool([approved]);
    const { service } = await makeService(pool);
    const action = await service.decide('user-1', 'action-1', 'approve', 'ok');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pending_motor_actions'),
      ['user-1', 'action-1', 'approved', 'ok'],
    );
    expect(action.status).toBe('approved');
    expect(action.decidedBy).toBe('user-1');
    expect(action.decidedAt).not.toBeNull();
  });

  it('maps reject to the rejected status', async () => {
    const rejected = { ...dbRow, status: 'rejected', decided_by: 'user-1' };
    const pool = mockPool([rejected]);
    const { service } = await makeService(pool);
    const action = await service.decide('user-1', 'action-1', 'reject');
    const args = (pool.query as jest.Mock).mock.calls[0][1] as unknown[];
    expect(args[2]).toBe('rejected');
    expect(args[3]).toBeNull();
    expect(action.status).toBe('rejected');
  });

  it('only decides rows still pending and owned by the user (WHERE clause)', async () => {
    const { service, pool } = await makeService(mockPool([dbRow]));
    await service.decide('user-1', 'action-1', 'approve');
    const sql = (pool.query as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('user_id = $1');
  });

  it('throws NotFoundException when no pending action matches', async () => {
    const { service } = await makeService(mockPool([]));
    await expect(
      service.decide('user-1', '00000000-0000-0000-0000-000000000000', 'approve'),
    ).rejects.toThrow(NotFoundException);
  });
});
