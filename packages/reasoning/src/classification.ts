// Lightweight node-type classification. Given a label and optional metadata,
// guess the KGNode `type` from a fixed taxonomy. Two strategies are layered:
//
//  1. URL/metadata heuristics — high-precision rules (e.g. github.com → repo).
//  2. Keyword pattern matching — lower precision, broader recall.
//
// The classifier is intentionally rule-based so its decisions are auditable;
// when an embedding model is wired up, this function gains a tie-breaker that
// uses cosine similarity to per-type prototype vectors.

import type { NodeType } from '@pkg/shared';

export interface ClassificationResult {
  type: NodeType;
  /** Confidence in [0, 1]. Reflects how strongly the input matched the rule
   *  that fired — not a calibrated probability. */
  confidence: number;
  /** Short human-readable explanation of which rule fired. */
  reason: string;
}

interface KeywordRule {
  type: NodeType;
  /** Whole-word keyword matches (case-insensitive). */
  keywords: string[];
  /** Higher number = preferred when multiple rules match with the same hit
   *  count. Lets us resolve ambiguity between e.g. "issue" and "task". */
  priority?: number;
}

const KEYWORD_RULES: KeywordRule[] = [
  { type: 'commit', keywords: ['commit', 'sha', 'merged', 'rebase'], priority: 3 },
  { type: 'pull_request', keywords: ['pr', 'pull', 'merge request', 'reviewed'], priority: 3 },
  { type: 'issue', keywords: ['issue', 'bug', 'ticket', 'incident'], priority: 2 },
  { type: 'task', keywords: ['todo', 'task', 'reminder', 'action item'], priority: 2 },
  { type: 'event', keywords: ['meeting', 'event', 'calendar', 'invite'], priority: 2 },
  { type: 'email', keywords: ['email', 'mail', 're:', 'fwd:', 'inbox'], priority: 2 },
  { type: 'person', keywords: ['contact', 'colleague', 'mentor'], priority: 1 },
  { type: 'document', keywords: ['document', 'doc', 'spec', 'pdf', 'whitepaper'], priority: 1 },
  { type: 'note', keywords: ['note', 'journal', 'log entry', 'idea'], priority: 1 },
  { type: 'bookmark', keywords: ['bookmark', 'saved link', 'read later'], priority: 1 },
  { type: 'concept', keywords: ['concept', 'theory', 'principle', 'pattern'], priority: 1 },
];

interface MetadataRule {
  type: NodeType;
  match: (input: ClassifyInput) => boolean;
  reason: string;
  confidence: number;
}

const METADATA_RULES: MetadataRule[] = [
  {
    type: 'commit',
    match: (i) => /\bcommit\b/.test(i.url ?? '') || /^[0-9a-f]{7,40}$/i.test(i.label.trim()),
    reason: 'git-commit-shaped identifier or URL',
    confidence: 0.9,
  },
  {
    type: 'pull_request',
    match: (i) => /\/pulls?\//.test(i.url ?? '') || /\/merge_requests\//.test(i.url ?? ''),
    reason: 'pull/merge request URL',
    confidence: 0.95,
  },
  {
    type: 'issue',
    match: (i) => /\/issues?\//.test(i.url ?? ''),
    reason: 'issue tracker URL',
    confidence: 0.9,
  },
  {
    type: 'repository',
    match: (i) =>
      /github\.com\/[^/]+\/[^/?#]+\/?$/.test(i.url ?? '') ||
      /gitlab\.com\/[^/]+\/[^/?#]+\/?$/.test(i.url ?? ''),
    reason: 'repository root URL',
    confidence: 0.9,
  },
  {
    type: 'email',
    match: (i) => i.connector === 'gmail' || i.connector === 'outlook_mail',
    reason: 'sourced from a mail connector',
    confidence: 0.85,
  },
  {
    type: 'event',
    match: (i) => i.connector === 'google_calendar' || i.connector === 'outlook_calendar',
    reason: 'sourced from a calendar connector',
    confidence: 0.85,
  },
  {
    type: 'task',
    match: (i) => i.connector === 'todoist' || i.connector === 'linear',
    reason: 'sourced from a task connector',
    confidence: 0.8,
  },
  {
    type: 'bookmark',
    match: (i) => i.connector === 'bookmarks',
    reason: 'sourced from the bookmarks connector',
    confidence: 0.95,
  },
];

export interface ClassifyInput {
  label: string;
  url?: string;
  /** Connector that produced the node, if known. */
  connector?: string;
  /** Free-form metadata; at present only inspected for `mimeType`. */
  metadata?: Record<string, unknown>;
}

/**
 * Classify an input into a `NodeType`. Returns the highest-confidence rule
 * match; falls back to `concept` with low confidence when nothing fires.
 */
export function classifyNode(input: ClassifyInput): ClassificationResult {
  for (const rule of METADATA_RULES) {
    if (rule.match(input)) {
      return { type: rule.type, confidence: rule.confidence, reason: rule.reason };
    }
  }

  const haystack = (input.label + ' ' + (input.url ?? '')).toLowerCase();
  let best: { rule: KeywordRule; hits: number } | null = null;
  for (const rule of KEYWORD_RULES) {
    let hits = 0;
    for (const kw of rule.keywords) {
      if (matchesKeyword(haystack, kw)) hits += 1;
    }
    if (hits === 0) continue;
    const better =
      best === null ||
      hits > best.hits ||
      (hits === best.hits && (rule.priority ?? 0) > (best.rule.priority ?? 0));
    if (better) best = { rule, hits };
  }
  if (best) {
    // Confidence = hit-ratio-of-keywords scaled, capped at 0.7 because keyword
    // rules are inherently fuzzy.
    const confidence = Math.min(0.7, 0.35 + 0.15 * best.hits);
    return {
      type: best.rule.type,
      confidence,
      reason: `matched ${best.hits} keyword${best.hits === 1 ? '' : 's'} for "${best.rule.type}"`,
    };
  }
  return {
    type: 'concept',
    confidence: 0.2,
    reason: 'no rules fired; defaulted to "concept"',
  };
}

/** Word-boundary match. Keywords that contain a space are matched as a phrase
 *  (still bounded). This prevents short keywords like "pr" from accidentally
 *  matching unrelated tokens like "project". */
function matchesKeyword(haystack: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  return re.test(haystack);
}
