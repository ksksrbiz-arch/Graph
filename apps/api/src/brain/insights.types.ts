// Boundary types for the Brain Insights surface — what the SPA sees when it
// asks "how is the brain growing right now?". These are deliberately narrow:
// they don't leak the internal SpikingSimulator structures, only the
// aggregates that are useful to a user.

import type { Region } from '@pkg/cortex';

export interface RegionActivity {
  region: Region;
  /** Spikes per second observed in the last `windowMs`. */
  rate: number;
  /** Raw count over the same window — useful for sparkline charts. */
  count: number;
  /** Hex colour for the region (mirrors @pkg/cortex REGION_STYLES). */
  color: string;
  label: string;
}

export interface PathwaySummary {
  synapseId: string;
  pre: string;
  post: string;
  /** Current weight in [0, 1]. */
  weight: number;
  /** Net weight change since the insight service started observing. */
  delta: number;
  /** ISO-8601 of the last potentiation/depression event. */
  lastChangeAt?: string;
}

export interface PathwayFormationEvent {
  synapseId: string;
  pre: string;
  post: string;
  /** Weight at the moment the synapse first crossed `formationThreshold`. */
  weight: number;
  /** ISO-8601 wall clock when the event was observed. */
  formedAt: string;
}

export interface ConnectomeSnapshot {
  /** ISO-8601 */
  at: string;
  neurons: number;
  synapses: number;
  /** Mean synapse weight across the whole connectome. */
  meanWeight: number;
}

export interface BrainInsightsSummary {
  running: boolean;
  windowMs: number;
  regions: RegionActivity[];
  /** Strongest pathways right now (sorted by weight desc). */
  strongestPathways: PathwaySummary[];
  /** Pathways with the largest positive delta over the observation window. */
  growingPathways: PathwaySummary[];
  /** Pathways with the largest negative delta (decaying / pruned). */
  decayingPathways: PathwaySummary[];
  /** Last N pathway-formation events (most recent first). */
  recentFormations: PathwayFormationEvent[];
  /** Recent connectome size + mean-weight samples for sparklines. */
  growth: ConnectomeSnapshot[];
}
