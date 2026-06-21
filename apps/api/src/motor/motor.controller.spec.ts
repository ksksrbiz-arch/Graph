// Unit tests for MotorController — supervisor + approval-queue are mocked.

import { Test } from '@nestjs/testing';
import { ApprovalQueueService } from './approval-queue.service';
import { MotorController } from './motor.controller';
import { SafetySupervisor } from './safety-supervisor';
import type { Request } from 'express';

interface AuthedRequest extends Request {
  user: { sub: string };
}

function authed(sub = 'user-1'): AuthedRequest {
  return { user: { sub } } as AuthedRequest;
}

async function makeController() {
  const supervisor = {
    evaluate: jest.fn(),
    recentDecisions: jest.fn().mockReturnValue([]),
  };
  const queue = {
    listPending: jest.fn().mockResolvedValue([]),
    decide: jest.fn().mockResolvedValue({ id: 'a-1', status: 'approved' }),
  };
  const mod = await Test.createTestingModule({
    controllers: [MotorController],
    providers: [
      { provide: SafetySupervisor, useValue: supervisor },
      { provide: ApprovalQueueService, useValue: queue },
    ],
  }).compile();
  return { controller: mod.get(MotorController), supervisor, queue };
}

describe('MotorController.queuePending', () => {
  it('lists pending actions for the authenticated subject', async () => {
    const { controller, queue } = await makeController();
    await controller.queuePending(authed('user-9'));
    expect(queue.listPending).toHaveBeenCalledWith('user-9');
  });
});

describe('MotorController.decide', () => {
  it('forwards the decision to the queue with the subject and id', async () => {
    const { controller, queue } = await makeController();
    const result = await controller.decide(authed('user-9'), 'a-1', {
      decision: 'approve',
      note: 'ok',
    });
    expect(queue.decide).toHaveBeenCalledWith('user-9', 'a-1', 'approve', 'ok');
    expect(result.status).toBe('approved');
  });

  it('passes a reject decision through unchanged', async () => {
    const { controller, queue } = await makeController();
    await controller.decide(authed(), 'a-2', { decision: 'reject' });
    expect(queue.decide).toHaveBeenCalledWith('user-1', 'a-2', 'reject', undefined);
  });
});
