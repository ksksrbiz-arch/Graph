/**
 * BrainSystem v2 — Advanced Neural Activity Engine
 * 
 * This is a significantly more sophisticated brain simulation compared to v1.
 * 
 * Features (current + planned):
 * - Multi-mode operation (Awake, Focused, Dreaming, Consolidation)
 * - Rich particle systems (energy flows, spike trains, attention ripples, memory replay)
 * - Per-node activation state with decay, amplification, and "echo" effects
 * - Hierarchical attention (global vs local focus)
 * - Integration points for Cortex reasoning events
 * - Event emission for HUD, audio, and external consumers
 */

export class BrainSystem {
  constructor(stateManager, options = {}) {
    this.state = stateManager;
    this.options = {
      maxParticles: 800,
      baseDecayRate: 0.0018,
      ...options,
    };

    // Core state
    this.nodeActivity = new Map(); // nodeId -> { activation, heat, glow, phase, lastSpike }
    this.particles = [];
    this.modes = {
      current: 'awake', // 'awake' | 'focused' | 'dreaming' | 'consolidating'
      intensity: 1.0,
    };

    this.attention = {
      globalFocus: null,
      localFoci: new Set(),
      strength: 0.6,
    };

    this.subscribers = new Set();
    this.eventLog = [];

    this._raf = null;
    this._lastTime = performance.now();
    this._isRunning = true;

    this._startSimulationLoop();
  }

  // ==================== PUBLIC API ====================

  subscribe(fn) {
    this.subscribers.add(fn);
    fn(this.getSnapshot());
    return () => this.subscribers.delete(fn);
  }

  getSnapshot() {
    return {
      nodeActivity: new Map(this.nodeActivity),
      particles: [...this.particles],
      mode: { ...this.modes },
      attention: {
        globalFocus: this.attention.globalFocus,
        localFoci: new Set(this.attention.localFoci),
        strength: this.attention.strength,
      },
      eventLog: [...this.eventLog],
    };
  }

  /**
   * Called when new nodes are ingested or discovered.
   */
  onNodesArrived(nodeIds, intensity = 0.9) {
    for (const id of nodeIds) {
      this._setNodeActivity(id, intensity, 'spawn');
    }
    this._logEvent(`New nodes perceived: ${nodeIds.length}`);
    this._publish();
  }

  /**
   * Trigger a focused attention ripple (e.g. from search or user click).
   */
  focusOn(nodeId, strength = 1.0) {
    this.attention.globalFocus = nodeId;
    this.attention.strength = strength;
    this.modes.current = 'focused';

    this._setNodeActivity(nodeId, 1.0, 'focus');

    // Create attention ripple particles
    this._spawnAttentionRipple(nodeId, strength);

    this._logEvent(`Attention focused on ${nodeId}`);
    this._publish();
  }

  /**
   * Fire a spike event (from the spiking layer).
   */
  onSpike(nodeId, intensity = 0.6) {
    this._setNodeActivity(nodeId, intensity, 'spike');
    this._spawnSpikeParticles(nodeId, intensity);
    this._publish();
  }

  /**
   * Trigger memory replay / consolidation waves (Dream mode).
   */
  enterDreamMode(intensity = 0.7) {
    this.modes.current = 'dreaming';
    this.modes.intensity = intensity;

    // Pick some high-recent-activity nodes and replay connections
    const activeNodes = Array.from(this.nodeActivity.entries())
      .sort((a, b) => b[1].activation - a[1].activation)
      .slice(0, 12);

    for (const [id] of activeNodes) {
      this._spawnDreamWave(id, intensity);
    }

    this._logEvent('Brain entering dream/consolidation phase');
    this._publish();
  }

  exitDreamMode() {
    this.modes.current = 'awake';
    this.modes.intensity = 1.0;
    this._logEvent('Brain returning to awake state');
    this._publish();
  }

  /**
   * External reasoning event (from Cortex).
   */
  onReasoningEvent(event) {
    if (event.type === 'inference') {
      this._spawnInferenceArc(event.from, event.to, event.reason);
    }
    this._logEvent(`Reasoning: ${event.reason || event.type}`);
  }

  destroy() {
    this._isRunning = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this.subscribers.clear();
    this.nodeActivity.clear();
    this.particles = [];
  }

  // ==================== INTERNAL SIMULATION ====================

  _startSimulationLoop() {
    const loop = (now) => {
      if (!this._isRunning) return;

      const dt = Math.min(now - this._lastTime, 50); // cap delta
      this._lastTime = now;

      this._updateActivity(dt);
      this._updateParticles(dt);
      this._autoModeTransitions();

      this._publish();
      this._raf = requestAnimationFrame(loop);
    };

    this._raf = requestAnimationFrame(loop);
  }

  _updateActivity(dt) {
    const decay = this.options.baseDecayRate * dt;

    for (const [id, act] of this.nodeActivity) {
      let newActivation = act.activation - decay * (this.modes.current === 'dreaming' ? 0.4 : 1.0);

      // Gentle sustain in dream mode
      if (this.modes.current === 'dreaming' && newActivation > 0.15) {
        newActivation = Math.max(newActivation, 0.12);
      }

      if (newActivation <= 0.02) {
        this.nodeActivity.delete(id);
      } else {
        this.nodeActivity.set(id, {
          ...act,
          activation: newActivation,
          heat: Math.max(0, act.heat - decay * 1.2),
          glow: Math.max(0, act.glow - decay * 0.8),
        });
      }
    }
  }

  _updateParticles(dt) {
    this.particles = this.particles.filter(p => {
      p.progress += dt / (p.duration || 900);
      p.x = p.startX + (p.endX - p.startX) * p.progress;
      p.y = p.startY + (p.endY - p.startY) * p.progress;
      return p.progress < 1.02;
    });

    // Occasionally spawn ambient energy in awake mode
    if (this.modes.current === 'awake' && Math.random() < 0.03) {
      const nodes = Array.from(this.nodeActivity.keys());
      if (nodes.length > 1) {
        const from = nodes[Math.floor(Math.random() * nodes.length)];
        const to = nodes[Math.floor(Math.random() * nodes.length)];
        if (from !== to) this._spawnAmbientParticle(from, to);
      }
    }
  }

  _autoModeTransitions() {
    // Simple auto return from focused/dreaming if nothing interesting happens
    if ((this.modes.current === 'focused' || this.modes.current === 'dreaming') && this.nodeActivity.size < 3) {
      if (Math.random() < 0.008) {
        this.modes.current = 'awake';
        this.attention.globalFocus = null;
      }
    }
  }

  _setNodeActivity(id, intensity, phase = 'idle') {
    const current = this.nodeActivity.get(id) || { activation: 0, heat: 0, glow: 0, phase: 'idle' };
    const newActivation = Math.min(1, current.activation + intensity * 0.65);

    this.nodeActivity.set(id, {
      activation: newActivation,
      heat: Math.min(1, current.heat + intensity * 0.5),
      glow: Math.min(1.2, current.glow + intensity * 0.7),
      phase,
      lastUpdate: Date.now(),
    });
  }

  _spawnAttentionRipple(centerId, strength) {
    // Create expanding ripple particles
    for (let i = 0; i < 14; i++) {
      this.particles.push({
        type: 'ripple',
        fromNodeId: centerId,
        progress: i * -0.04,
        duration: 1100 + i * 40,
        size: 3 + strength * 2,
        color: `hsl(220, 90%, ${85 + strength * 10}%)`,
        opacity: 0.7,
      });
    }
  }

  _spawnSpikeParticles(nodeId, intensity) {
    const count = Math.floor(3 + intensity * 7);
    for (let i = 0; i < count; i++) {
      this.particles.push({
        type: 'spike',
        fromNodeId: nodeId,
        progress: 0,
        duration: 280 + Math.random() * 180,
        size: 1.5 + intensity,
        color: '#a5b4fc',
        opacity: 0.9,
      });
    }
  }

  _spawnDreamWave(fromId, intensity) {
    this.particles.push({
      type: 'dream-wave',
      fromNodeId: fromId,
      progress: 0,
      duration: 2400,
      size: 2.5,
      color: '#c084fc',
      opacity: 0.35 * intensity,
    });
  }

  _spawnInferenceArc(fromId, toId, reason) {
    this.particles.push({
      type: 'inference',
      fromNodeId: fromId,
      toNodeId: toId,
      progress: 0,
      duration: 1600,
      size: 2,
      color: '#67e8f9',
      opacity: 0.85,
      reason,
    });
  }

  _spawnAmbientParticle(fromId, toId) {
    this.particles.push({
      type: 'ambient',
      fromNodeId: fromId,
      toNodeId: toId,
      progress: 0,
      duration: 1600 + Math.random() * 900,
      size: 1.2,
      color: '#6474ff',
      opacity: 0.18,
    });
  }

  _publish() {
    const snap = this.getSnapshot();
    for (const fn of this.subscribers) {
      try {
        fn(snap);
      } catch (e) {
        console.warn('[BrainSystem] Subscriber error:', e);
      }
    }
  }

  _logEvent(message) {
    this.eventLog.unshift({ t: Date.now(), msg: message });
    if (this.eventLog.length > 60) this.eventLog.pop();
  }
}
