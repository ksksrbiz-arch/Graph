# Graph UI v2 — High-Effort Rebuild

This directory contains a ground-up, maximum-effort rebuild of the Personal Knowledge Graph visualization interface.

## Design Goals

- **Beauty & "Aliveness"**: The brain/spiking/animation layer must feel alive and neural. This is the soul of the project.
- **Clarity & Maintainability**: Much better module boundaries than the original sprawling `web/` implementation.
- **Performance**: Smooth even with 5k–10k+ nodes.
- **Interaction Excellence**: Best-in-class graph navigation, focus, selection, and context.
- **Extensibility**: Easy to add new renderers, effects, HUD elements, and brain behaviors.
- **Preservation**: All existing data models and backend integration remain compatible.

## Architecture

### Core Principles
- **Orchestrator + Specialized Modules**: One main `GraphView` that coordinates everything.
- **Renderer Abstraction**: 2D, 3D, and future renderers implement the same interface.
- **Brain System as First-Class Citizen**: The brain animation, spiking, and perception effects are not bolted on — they are central.
- **Pure Data + Reactive UI**: State lives in a clean data layer. The UI reacts.
- **Progressive Enhancement**: Advanced effects gracefully degrade.

### Module Structure

```
web/ui/
├── core/
│   ├── GraphView.js          # Main orchestrator
│   ├── StateManager.js       # Clean state + subscriptions
│   └── types.js              # JSDoc / shared types
├── renderers/
│   ├── BaseRenderer.js
│   ├── Graph2DRenderer.js
│   └── Graph3DRenderer.js
├── brain/
│   ├── BrainSystem.js        # High-level brain controller
│   ├── SpikingEngine.js
│   ├── AnimationOrchestrator.js
│   └── Effects/              # Individual visual effects
├── interactions/
│   ├── InteractionManager.js
│   ├── Selection.js
│   ├── Focus.js
│   └── Gestures.js
├── hud/
│   └── (modular HUD components)
├── utils/
│   └── ...
└── index.js                  # Public entry point
```

## Current Status

This is an active high-effort rebuild. The goal is to eventually replace the old `web/` implementation with this one while offering a significantly superior experience.

---

**Status**: Scaffolding phase. Core architecture and first modules are being built with maximum care and quality.
