// Single re-export surface for `@pkg/shared`. Consumers should import from this
// module only, never from internal paths — keeps the public contract stable.

export * from './types.js';
export * from './connectors.js';
export * from './schemas.js';
export * as Mocks from './mocks/index.js';
