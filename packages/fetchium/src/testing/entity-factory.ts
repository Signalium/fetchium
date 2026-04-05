import type { Entity } from '../proxy.js';
import type { FieldGenerator, EntityGenerators } from './types.js';
import { GeneratorContext, generateEntityData } from './auto-generate.js';

export class EntityFactory<T extends Entity> {
  private cls: new () => T;
  private generators: Record<string, FieldGenerator | unknown>;
  private ctx: GeneratorContext;

  constructor(cls: new () => T, generators: EntityGenerators<T>, ctx?: GeneratorContext) {
    this.cls = cls;
    this.generators = generators as Record<string, FieldGenerator | unknown>;
    this.ctx = ctx ?? new GeneratorContext();
    this.ctx.registerFactory(cls, this.generators);
  }

  build(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
    return generateEntityData(this.cls, overrides as Record<string, unknown>, this.ctx);
  }

  buildMany(count: number, overrides?: Partial<Record<string, unknown>>): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < count; i++) {
      results.push(this.build(overrides as Record<string, unknown>));
    }
    return results;
  }
}

export function defineFactory<T extends Entity>(
  cls: new () => T,
  generators: EntityGenerators<T>,
): EntityFactory<T> {
  return new EntityFactory(cls, generators);
}
