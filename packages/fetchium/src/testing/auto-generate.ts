import { ValidatorDef, getEntityDef, CaseInsensitiveSet } from '../typeDefs.js';
import { Mask, type InternalTypeDef, type InternalObjectShape } from '../types.js';
import type { Entity } from '../proxy.js';
import type { FieldGenerator } from './types.js';

// ================================
// Generator Context
// ================================

export class GeneratorContext {
  private idCounters = new Map<string, number>();
  private seqCounters = new Map<string, number>();
  private visiting = new Set<string>();
  private factories = new Map<new () => Entity, Record<string, FieldGenerator | unknown>>();

  registerFactory(cls: new () => Entity, generators: Record<string, FieldGenerator | unknown>): void {
    this.factories.set(cls, generators);
  }

  nextId(typename?: string): string {
    const key = typename ?? '__global';
    const current = this.idCounters.get(key) ?? 0;
    const next = current + 1;
    this.idCounters.set(key, next);
    return String(next);
  }

  nextSeq(typename?: string): number {
    const key = typename ?? '__global';
    const current = this.seqCounters.get(key) ?? 0;
    const next = current + 1;
    this.seqCounters.set(key, next);
    return next;
  }

  getFactory(cls: new () => Entity): Record<string, FieldGenerator | unknown> | undefined {
    return this.factories.get(cls);
  }

  enterEntity(typename: string): boolean {
    if (this.visiting.has(typename)) return false;
    this.visiting.add(typename);
    return true;
  }

  leaveEntity(typename: string): void {
    this.visiting.delete(typename);
  }

  reset(): void {
    this.idCounters.clear();
    this.seqCounters.clear();
    this.visiting.clear();
  }
}

// ================================
// Type-def walker
// ================================

export function generateFromTypeDef(
  typeDef: InternalTypeDef,
  fieldName: string,
  ctx: GeneratorContext,
): unknown {
  if (typeof typeDef === 'number') {
    return generateFromMask(typeDef as Mask, fieldName, ctx);
  }

  if (typeDef instanceof Set || typeDef instanceof CaseInsensitiveSet) {
    const first = typeDef.values().next();
    return first.done ? undefined : first.value;
  }

  if (typeDef instanceof ValidatorDef) {
    return generateFromValidatorDef(typeDef, fieldName, ctx);
  }

  return undefined;
}

function generateFromMask(mask: Mask, fieldName: string, ctx: GeneratorContext): unknown {
  if (mask & Mask.ID) {
    return ctx.nextId();
  }

  const baseMask = mask & 0xffff;

  if (baseMask & Mask.HAS_FORMAT) {
    return '2024-01-01T00:00:00.000Z';
  }

  if (baseMask & Mask.STRING) return `${fieldName}_${ctx.nextSeq()}`;
  if (baseMask & Mask.NUMBER) return ctx.nextSeq();
  if (baseMask & Mask.BOOLEAN) return true;
  if (baseMask & Mask.NULL) {
    if (baseMask & ~(Mask.NULL | Mask.UNDEFINED)) {
      return generateFromMask((baseMask & ~(Mask.NULL | Mask.UNDEFINED)) as Mask, fieldName, ctx);
    }
    return null;
  }
  if (baseMask & Mask.UNDEFINED) {
    if (baseMask & ~(Mask.UNDEFINED | Mask.NULL)) {
      return generateFromMask((baseMask & ~(Mask.UNDEFINED | Mask.NULL)) as Mask, fieldName, ctx);
    }
    return undefined;
  }

  return undefined;
}

function generateFromValidatorDef(
  def: ValidatorDef<any>,
  fieldName: string,
  ctx: GeneratorContext,
): unknown {
  const mask = def.mask;

  if (mask & Mask.ENTITY) {
    return generateEntity(def, ctx);
  }

  if (mask & Mask.UNION) {
    return generateUnion(def, fieldName, ctx);
  }

  if (mask & Mask.ARRAY) {
    const innerDef = def.shape as InternalTypeDef;
    if (innerDef !== undefined) {
      return [generateFromTypeDef(innerDef, fieldName, ctx)];
    }
    return [];
  }

  if (mask & Mask.RECORD) {
    const innerDef = def.shape as InternalTypeDef;
    if (innerDef !== undefined) {
      return { ['key_0']: generateFromTypeDef(innerDef, fieldName, ctx) };
    }
    return {};
  }

  if (mask & Mask.PARSE_RESULT) {
    const innerDef = def.shape as InternalTypeDef;
    if (innerDef !== undefined) {
      return { success: true, value: generateFromTypeDef(innerDef, fieldName, ctx) };
    }
    return { success: true, value: undefined };
  }

  if (mask & Mask.OBJECT) {
    return generateObject(def.shape as InternalObjectShape, ctx);
  }

  if (def.values) {
    const first = def.values.values().next();
    return first.done ? undefined : first.value;
  }

  return generateFromMask(mask, fieldName, ctx);
}

function generateObject(
  shape: InternalObjectShape,
  ctx: GeneratorContext,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, fieldDef] of Object.entries(shape)) {
    const value = generateFromTypeDef(fieldDef as InternalTypeDef, key, ctx);
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

function generateEntity(
  def: ValidatorDef<any>,
  ctx: GeneratorContext,
): Record<string, unknown> {
  const typename = def.typenameValue;
  const typenameField = def.typenameField;
  const idField = def.idField;
  const shape = def.shape as InternalObjectShape;

  if (typename && !ctx.enterEntity(typename)) {
    const stub: Record<string, unknown> = {};
    if (typenameField) stub[typenameField] = typename;
    if (typeof idField === 'string') stub[idField] = ctx.nextId(typename);
    return stub;
  }

  const factory = def._entityClass ? ctx.getFactory(def._entityClass) : undefined;
  const seq = ctx.nextSeq(typename);

  const result: Record<string, unknown> = {};

  if (shape) {
    for (const [key, fieldDef] of Object.entries(shape)) {
      if (typeof fieldDef === 'string') {
        result[key] = fieldDef;
        continue;
      }

      if (key === (idField as string)) {
        result[key] = ctx.nextId(typename);
        continue;
      }

      result[key] = generateFromTypeDef(fieldDef as InternalTypeDef, key, ctx);
    }
  }

  if (factory) {
    const partialResult: Record<string, unknown> = { ...result };
    for (const [key, gen] of Object.entries(factory)) {
      if (typeof gen === 'function') {
        partialResult[key] = (gen as FieldGenerator)(seq, partialResult);
      } else {
        partialResult[key] = gen;
      }
    }
    Object.assign(result, partialResult);
  }

  if (typename) ctx.leaveEntity(typename);

  return result;
}

function generateUnion(
  def: ValidatorDef<any>,
  fieldName: string,
  ctx: GeneratorContext,
): unknown {
  const shape = def.shape as Record<string, ValidatorDef<any>> | undefined;

  if (shape === undefined) return undefined;

  for (const key of Object.keys(shape)) {
    if (typeof key === 'string') {
      const variant = shape[key];
      if (variant instanceof ValidatorDef) {
        return generateFromValidatorDef(variant, fieldName, ctx);
      }
    }
  }

  return undefined;
}

// ================================
// High-level helpers
// ================================

export function generateEntityData(
  cls: new () => Entity,
  overrides?: Record<string, unknown>,
  ctx?: GeneratorContext,
): Record<string, unknown> {
  const context = ctx ?? new GeneratorContext();
  const def = getEntityDef(cls);
  const data = generateEntity(def, context);

  if (overrides) {
    deepMerge(data, overrides);
  }

  return data;
}

export function generateQueryResponse(
  resultDef: InternalTypeDef | InternalObjectShape,
  ctx: GeneratorContext,
  overrides?: Record<string, unknown>,
): unknown {
  let data: unknown;

  if (resultDef instanceof ValidatorDef) {
    data = generateFromValidatorDef(resultDef, 'result', ctx);
  } else if (typeof resultDef === 'object' && resultDef !== null) {
    data = generateObject(resultDef as InternalObjectShape, ctx);
  } else {
    data = generateFromTypeDef(resultDef as InternalTypeDef, 'result', ctx);
  }

  if (overrides && typeof data === 'object' && data !== null) {
    deepMerge(data as Record<string, unknown>, overrides);
  }

  return data;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}
