// Human-in-the-loop approval queue for motor intents. Intents that the
// SafetySupervisor routes to 'requires-approval' are enqueued here and held
// until a human explicitly approves or rejects them. Backed by the
// `pending_motor_actions` Postgres table (infra/postgres/init/001-schema.sql).

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { POSTGRES_POOL } from '../shared/postgres/postgres.module';
import type { MotorIntent } from './safety-supervisor';

export type PendingActionStatus = 'pending' | 'approved' | 'rejected';
export type ActionDecision = 'approve' | 'reject';

export interface PendingActionRow {
  id: string;
  user_id: string;
  action: string;
  payload: Record<string, unknown>;
  neuron_id: string | null;
  confidence: number;
  status: PendingActionStatus;
  decided_by: string | null;
  decision_note: string | null;
  created_at: Date;
  decided_at: Date | null;
}

export interface PendingAction {
  id: string;
  userId: string;
  action: string;
  payload: Record<string, unknown>;
  neuronId: string | null;
  confidence: number;
  status: PendingActionStatus;
  decidedBy: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

@Injectable()
export class ApprovalQueueService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  /** Enqueue a proposed motor intent for human approval. */
  async enqueue(userId: string, intent: MotorIntent): Promise<PendingAction> {
    const result = await this.pool.query<PendingActionRow>(
      `INSERT INTO pending_motor_actions
         (user_id, action, payload, neuron_id, confidence)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        userId,
        intent.action,
        JSON.stringify(intent.payload ?? {}),
        intent.neuronId ?? null,
        intent.confidence,
      ],
    );
    return this.toPending(result.rows[0]);
  }

  /** List pending (undecided) actions for a user, newest first. */
  async listPending(userId: string, limit = 50): Promise<PendingAction[]> {
    const result = await this.pool.query<PendingActionRow>(
      `SELECT * FROM pending_motor_actions
       WHERE user_id = $1 AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return result.rows.map((row) => this.toPending(row));
  }

  /**
   * Approve or reject a pending action. Only an action that is still
   * 'pending' and owned by the user can be decided; the transition is atomic.
   */
  async decide(
    userId: string,
    id: string,
    decision: ActionDecision,
    note?: string,
  ): Promise<PendingAction> {
    const nextStatus: PendingActionStatus =
      decision === 'approve' ? 'approved' : 'rejected';
    const result = await this.pool.query<PendingActionRow>(
      `UPDATE pending_motor_actions
       SET status = $3,
           decided_by = $1,
           decision_note = $4,
           decided_at = now()
       WHERE id = $2 AND user_id = $1 AND status = 'pending'
       RETURNING *`,
      [userId, id, nextStatus, note ?? null],
    );
    if (!result.rows[0]) {
      throw new NotFoundException(`no pending motor action: ${id}`);
    }
    return this.toPending(result.rows[0]);
  }

  private toPending(row: PendingActionRow): PendingAction {
    return {
      id: row.id,
      userId: row.user_id,
      action: row.action,
      payload: row.payload ?? {},
      neuronId: row.neuron_id,
      confidence: Number(row.confidence),
      status: row.status,
      decidedBy: row.decided_by,
      decisionNote: row.decision_note,
      createdAt: row.created_at.toISOString(),
      decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    };
  }
}
