// @ts-check
/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
module.exports = {
  packageManager: 'pnpm',
  reporters: ['html', 'clear-text', 'progress'],
  plugins: [
    '@stryker-mutator/jest-runner',
    '@stryker-mutator/typescript-checker',
  ],
  testRunner: 'jest',
  jest: {
    projectType: 'custom',
    configFile: 'package.json',
    enableFindRelatedTests: true,
  },
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  coverageAnalysis: 'perTest',
  mutate: [
    'src/**/*.ts',
    '!src/**/*.module.ts',
    '!src/**/*.dto.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.e2e-spec.ts',
    '!src/main.ts',
  ],
  thresholds: {
    high: 80,
    low: 70,
    break: 70,
  },
  timeoutMS: 30000,
  concurrency: 4,
};
