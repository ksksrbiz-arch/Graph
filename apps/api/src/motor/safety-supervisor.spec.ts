import { SafetySupervisor, type MotorIntent } from './safety-supervisor';

describe('SafetySupervisor', () => {
  function intent(overrides: Partial<MotorIntent> = {}): MotorIntent {
    return {
      action: 'log_observation',
      payload: { text: 'hi' },
      neuronId: 'n-1',
      confidence: 0.9,
      ...overrides,
    };
  }

  it('allows a benign intent within all limits', () => {
    const sup = new SafetySupervisor();
    const v = sup.evaluate(intent());
    expect(v).toEqual({ allow: true, reason: 'within-limits' });
  });

  it('blocks low-confidence intents below the floor', () => {
    const sup = new SafetySupervisor();
    const v = sup.evaluate(intent({ confidence: 0.1 }));
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.reason).toBe('low-confidence');
  });

  it('denylists payloads containing dangerous substrings', () => {
    const sup = new SafetySupervisor();
    const v = sup.evaluate(intent({ payload: { cmd: 'rm -rf /' } }));
    expect(v).toEqual({ allow: false, reason: 'denylisted', detail: 'rm -rf' });
  });

  it('denylist scan is case-insensitive across nested payload values', () => {
    const sup = new SafetySupervisor();
    const v = sup.evaluate(
      intent({ payload: { sql: { stmt: 'drop table users' } } }),
    );
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.reason).toBe('denylisted');
  });

  it('forces high-impact actions through the approval gate', () => {
    const sup = new SafetySupervisor();
    const v = sup.evaluate(intent({ action: 'send_email' }));
    expect(v).toEqual({
      allow: false,
      reason: 'requires-approval',
      detail: 'send_email',
    });
  });

  it('rate-limits the same allowed action past the per-minute cap', () => {
    const sup = new SafetySupervisor();
    // PER_ACTION_LIMIT = 6 — the seventh call within the window must fail.
    for (let i = 0; i < 6; i++) {
      expect(sup.evaluate(intent()).allow).toBe(true);
    }
    const v = sup.evaluate(intent());
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.reason).toBe('rate-limited');
  });

  it('low-confidence rule short-circuits before denylist scan', () => {
    // Both rules would fire; low-confidence runs first, so its verdict wins.
    const sup = new SafetySupervisor();
    const v = sup.evaluate(
      intent({ confidence: 0.1, payload: { cmd: 'rm -rf /' } }),
    );
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.reason).toBe('low-confidence');
  });

  it('exposes recent decisions, newest first', () => {
    const sup = new SafetySupervisor();
    sup.evaluate(intent({ neuronId: 'a' }));
    sup.evaluate(intent({ neuronId: 'b' }));
    const recent = sup.recentDecisions(10);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.intent.neuronId).toBe('b');
    expect(recent[1]?.intent.neuronId).toBe('a');
  });
});
