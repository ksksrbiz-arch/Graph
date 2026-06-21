import { describe, expect, it } from 'vitest';
import {
  NODE_TYPES,
  NODE_TYPE_COLORS,
  PALETTE_12,
  colorForNodeType,
} from '../index.js';

describe('node-type palette', () => {
  it('maps every NodeType to a palette colour', () => {
    for (const type of NODE_TYPES) {
      expect(NODE_TYPE_COLORS[type]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(PALETTE_12).toContain(NODE_TYPE_COLORS[type]);
    }
  });

  it('resolves known types via colorForNodeType', () => {
    expect(colorForNodeType('person')).toBe(NODE_TYPE_COLORS.person);
    expect(colorForNodeType('code')).toBe(NODE_TYPE_COLORS.code);
  });

  it('falls back to a palette colour for unknown or missing types', () => {
    const fallback = colorForNodeType('not-a-real-type');
    expect(PALETTE_12).toContain(fallback);
    expect(colorForNodeType(undefined)).toBe(fallback);
  });
});
