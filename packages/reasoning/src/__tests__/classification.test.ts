import { describe, expect, it } from 'vitest';
import { classifyNode } from '../classification.js';

describe('classifyNode', () => {
  it('classifies a github commit URL as commit', () => {
    const r = classifyNode({
      label: 'fix: handle empty input',
      url: 'https://github.com/owner/repo/commit/abc1234',
    });
    expect(r.type).toBe('commit');
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it('classifies a 40-char hex id as commit', () => {
    const r = classifyNode({
      label: 'a1b2c3d4e5f6789012345678901234567890abcd',
    });
    expect(r.type).toBe('commit');
  });

  it('classifies a github pulls URL as pull_request', () => {
    const r = classifyNode({
      label: 'Add idempotency layer',
      url: 'https://github.com/owner/repo/pull/42',
    });
    expect(r.type).toBe('pull_request');
  });

  it('classifies a github issue URL as issue', () => {
    const r = classifyNode({
      label: 'Bug in login flow',
      url: 'https://github.com/owner/repo/issues/7',
    });
    expect(r.type).toBe('issue');
  });

  it('classifies a github repository root URL as repository', () => {
    const r = classifyNode({
      label: 'owner/repo',
      url: 'https://github.com/owner/repo',
    });
    expect(r.type).toBe('repository');
  });

  it('uses the connector hint to infer email', () => {
    const r = classifyNode({ label: 'Re: lunch?', connector: 'gmail' });
    expect(r.type).toBe('email');
  });

  it('uses the connector hint to infer event', () => {
    const r = classifyNode({ label: 'Standup', connector: 'google_calendar' });
    expect(r.type).toBe('event');
  });

  it('falls back to keyword matching when no metadata rule fires', () => {
    const r = classifyNode({ label: 'Project meeting tomorrow' });
    expect(r.type).toBe('event');
    expect(r.confidence).toBeLessThanOrEqual(0.7);
  });

  it('returns concept with low confidence when nothing matches', () => {
    const r = classifyNode({ label: 'xyzzy plugh' });
    expect(r.type).toBe('concept');
    expect(r.confidence).toBeLessThan(0.5);
  });

  it('exposes a non-empty reason', () => {
    expect(classifyNode({ label: 'hello' }).reason).toBeTruthy();
  });
});
