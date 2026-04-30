// Quality-tier setting (Performance | Balanced | Ultra) and GPU guard.
// Implements Visual Spec Part 2 §5 — bloom strength is derived from the tier
// so the Brain Controls panel and the 3D renderer share a single source of
// truth via state.config.qualityTier.

import { state, setConfig } from '../state.js';

export const QUALITY_TIERS = ['perf', 'balanced', 'ultra'];

/** Map a tier to its bloom.strength multiplier (spec §5). */
export function bloomStrengthFor(tier) {
  switch (tier) {
    case 'ultra':    return 1.2;
    case 'balanced': return 0.85;
    case 'perf':     return 0.0;
    default:         return 0.85;
  }
}

/** Inspect the user's GPU and decide whether to flag low-end hardware.
 *  Returns { weak: boolean, reason: string|null }. */
export function detectWeakGpu() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return { weak: true, reason: 'WebGL unavailable' };
    let vendor = '';
    let renderer = '';
    const dbg = gl.getExtension && gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      vendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '');
      renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
    } else {
      vendor = String(gl.getParameter(gl.VENDOR) || '');
      renderer = String(gl.getParameter(gl.RENDERER) || '');
    }
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
    if (vendor.toLowerCase().includes('intel') || renderer.toLowerCase().includes('intel')) {
      return { weak: true, reason: `Intel GPU detected (${renderer || vendor})` };
    }
    if (maxTex && maxTex < 8192) {
      return { weak: true, reason: `MAX_TEXTURE_SIZE=${maxTex} (<8192)` };
    }
    return { weak: false, reason: null };
  } catch (e) {
    return { weak: false, reason: null };
  }
}

let cachedGpu = null;
export function getGpuStatus() {
  if (cachedGpu) return cachedGpu;
  cachedGpu = detectWeakGpu();
  return cachedGpu;
}

/** Spec §5 default — Balanced. Strong hardware can opt into Ultra; weak
 *  hardware (Intel / MAX_TEXTURE_SIZE < 8192) is also pinned to Balanced
 *  with a notice surfaced in the Brain Controls panel. */
export function defaultTier() {
  return 'balanced';
}

export function getQualityTier() {
  return state.config.qualityTier || defaultTier();
}

export function setQualityTier(tier) {
  if (!QUALITY_TIERS.includes(tier)) return;
  setConfig({ qualityTier: tier });
}

export function ensureQualityTierInit() {
  if (!state.config.qualityTier) {
    state.config.qualityTier = defaultTier();
  }
}
