import { describe, expect, it } from 'vitest';
import { NODE_TYPES } from '@pkg/shared';
import {
  REGIONS,
  REGION_STYLES,
  regionForNode,
  regionForNodeType,
  styleForRegion,
} from '../regions.js';

describe('cortex regions', () => {
  it('assigns a region to every NodeType in the v2 taxonomy', () => {
    for (const t of NODE_TYPES) {
      const r = regionForNodeType(t);
      expect(REGIONS).toContain(r);
    }
  });

  it('lets connector identity override the type-based default', () => {
    // A note coming from gmail is sensory (incoming message), not memory.
    expect(regionForNode({ type: 'note', sourceId: 'gmail' })).toBe('sensory');
    expect(regionForNode({ type: 'note' })).toBe('memory');
  });

  it('returns a non-empty style record for every region', () => {
    for (const r of REGIONS) {
      const s = styleForRegion(r);
      expect(s.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  it('keeps REGION_STYLES and REGIONS in sync', () => {
    const styled = Object.keys(REGION_STYLES).sort();
    const declared = [...REGIONS].sort();
    expect(styled).toEqual(declared);
  });

  it('routes person nodes into limbic and commit nodes into motor', () => {
    expect(regionForNodeType('person')).toBe('limbic');
    expect(regionForNodeType('commit')).toBe('motor');
  });
});
