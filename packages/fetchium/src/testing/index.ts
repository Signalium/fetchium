// Core mock client
export { MockClient, MockQueryBuilder } from './MockClient.js';

// Entity data generation
export { generateEntityData as entity } from './auto-generate.js';
export { GeneratorContext } from './auto-generate.js';

// Entity factories
export { defineFactory, EntityFactory } from './entity-factory.js';

// Query variation knobs
export { varyQuery } from './vary-query.js';
export type { QueryVaryConfig, QueryVaryState } from './vary-query.js';

// Re-export vitest-vary for convenience
export { test, it, varyTest, VaryKnob } from 'vitest-vary';
export type { VaryCase, VariantContext, VaryOpts, VaryHandle, TestFn } from 'vitest-vary';

// Types
export type {
  DotPaths,
  VaryableFields,
  MockFetchCall,
  FieldGenerator,
  EntityGenerators,
  ResponseTransform,
} from './types.js';
