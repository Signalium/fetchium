// Core mock client
export { MockClient, MockQueryBuilder } from './MockClient.js';

// Entity data generation
export { generateEntityData as entity } from './auto-generate.js';
export { GeneratorContext } from './auto-generate.js';

// Entity factories
export { defineFactory, EntityFactory } from './entity-factory.js';

// Types
export type {
  DotPaths,
  VaryableFields,
  MockFetchCall,
  FieldGenerator,
  EntityGenerators,
  ResponseTransform,
} from './types.js';
