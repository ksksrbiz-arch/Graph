import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: {
        // Spec §11.1: shared types/schemas count as connector-transform-adjacent
        // glue; aim for 90%+ once Phase 0 wires up CI.
        lines: 90,
        functions: 90,
        branches: 80,
        statements: 90,
      },
    },
  },
});
