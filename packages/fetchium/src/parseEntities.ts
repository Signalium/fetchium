// -----------------------------------------------------------------------------
// Parse System
//
// parseEntities/parseData: Validates, formats, produces parsed entity data
//   objects. Entities are deduplicated via ctx.seen/ctx.seenByKey.
// -----------------------------------------------------------------------------

import { hashValue } from 'signalium/utils';
import type { QueryClient, PreloadedEntityMap } from './QueryClient.js';
import type { EntityInstance } from './EntityInstance.js';
import {
  CaseInsensitiveSet,
  FormattedValue,
  FORMAT_MASK_SHIFT,
  ValidatorDef,
  VariantGroup,
  VariantSet,
} from './typeDefs.js';
import { typeError, typeToString, UnknownUnionVariantError, CachedEntityMismatchError } from './errors.js';
import {
  ARRAY_KEY,
  ArrayDef,
  ComplexTypeDef,
  EntityDef,
  InternalObjectFieldTypeDef,
  LiveFieldType,
  Mask,
  ObjectDef,
  ParseResultDef,
  RECORD_KEY,
  RecordDef,
  TypeDef,
  UnionDef,
} from './types.js';
import { typeMaskOf } from './utils.js';
import { PROXY_ID } from './proxyId.js';

import type { WarnFn } from './proxy.js';

const entries = Object.entries;
const noopWarn: WarnFn = () => {};

// ======================================================
// ParsedEntity — lightweight struct for parsed entity data
// ======================================================

export interface ParsedEntity {
  key: number;
  shape: EntityDef;
  data: Record<string, unknown>;
  /** Set for partial event updates — restricts mergeFields to only these keys. */
  rawKeys: Set<string> | undefined;
  /** The keys a streamed event carried, whether or not the entity was in memory. */
  eventKeys: Set<string> | undefined;
  /** A cached record parsed to fill in the fields an entity built from events lacks. */
  fillsPartial: boolean;
}

/** Trust-memory verdicts: `true`/`false` once settled, `'pending'` while a check is in progress (a cycle). */
export type TrustMemo = Map<EntityInstance, Map<ValidatorDef<unknown>, boolean | 'pending'>>;

// ======================================================
// Parse context — bundles threading parameters
// ======================================================

export class ParseContext {
  queryClient: QueryClient | undefined = undefined;
  preloadedEntities: PreloadedEntityMap | undefined = undefined;
  warn: WarnFn = noopWarn;
  /** When true, missing optional fields on existing entities are set to
   *  undefined. False for mutation events (truly partial payloads). */
  isPartialEvent: boolean = false;
  seen: Map<Record<string, unknown>, ParsedEntity> | undefined = undefined;
  seenByKey: Map<number, ParsedEntity> | undefined = undefined;
  /** Verdicts of the trust-memory check, per instance and def, for one parse. */
  trusted: TrustMemo | undefined = undefined;

  reset(
    queryClient: QueryClient | undefined,
    preloadedEntities: PreloadedEntityMap | undefined,
    warn: WarnFn,
    isPartialEvent: boolean = false,
  ): void {
    this.queryClient = queryClient;
    this.preloadedEntities = preloadedEntities;
    this.warn = warn;
    this.isPartialEvent = isPartialEvent;
    this.trusted = undefined;
    if (queryClient !== undefined) {
      if (this.seen === undefined) {
        this.seen = new Map();
        this.seenByKey = new Map();
      } else {
        this.seen.clear();
        this.seenByKey!.clear();
      }
    }
  }
}

export interface ParseResult {
  data: unknown;
  ctx: ParseContext;
}

// ======================================================
// Entry points
// ======================================================

/**
 * Parse data: validates types, applies formats, produces parsed entity data
 * objects (stored in ctx.seen). Does NOT touch the entity store.
 *
 * After parsing, call applyEntityRefs() to apply entities and reify the tree.
 */
export function parseEntities(value: unknown, typeDef: TypeDef | ComplexTypeDef, ctx: ParseContext): unknown {
  return parseData(value, typeDef, ctx, '');
}

/**
 * Standalone value parser for non-entity values. Used by tests and LiveCollection.
 * Validates types and applies eager formats. Does not perform entity resolution.
 */
export function parseValue(
  value: unknown,
  typeDef: TypeDef | ComplexTypeDef,
  path: string,
  warn: WarnFn = noopWarn,
): unknown {
  const ctx = new ParseContext();
  ctx.reset(undefined, undefined, warn);
  const result = parseData(value, typeDef, ctx, path);
  return unwrapFormattedValues(result);
}

/**
 * Parse a single entity. Returns its parsed data object.
 */
export function parseEntity(
  obj: Record<string, unknown>,
  entityShape: EntityDef,
  ctx: ParseContext,
): Record<string, unknown> {
  return parseEntityData(obj, entityShape, ctx);
}

// ======================================================
// Internal helpers
// ======================================================

function unwrapFormattedValues(value: unknown): unknown {
  if (value instanceof FormattedValue) {
    return value.getValue();
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = unwrapFormattedValues(value[i]);
    }
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      obj[key] = unwrapFormattedValues(obj[key]);
    }
  }
  return value;
}

function parseFormattedValue(
  mask: number,
  value: unknown,
  ctx: ParseContext,
  path: string,
): FormattedValue | undefined {
  const formatId = mask >> FORMAT_MASK_SHIFT;
  const eager = (mask & Mask.IS_EAGER_FORMAT) !== 0;
  if (eager) {
    try {
      return new FormattedValue(value, formatId, true);
    } catch (e) {
      if ((mask & Mask.UNDEFINED) !== 0) {
        ctx.warn('Invalid formatted value for optional type, defaulting to undefined', {
          value,
          path,
          error: e instanceof Error ? e.message : String(e),
        });
        return undefined;
      }
      throw e;
    }
  }
  return new FormattedValue(value, formatId, false);
}

// ======================================================
// Parse dispatcher
// ======================================================

function parseData(value: unknown, typeDef: TypeDef | ComplexTypeDef, ctx: ParseContext, path: string): unknown {
  const def = typeDef as unknown as InternalObjectFieldTypeDef;

  if (def instanceof CaseInsensitiveSet) {
    const canonical = def.get(value);
    if (canonical === undefined) throw typeError(path, def as any, value);
    return canonical;
  }

  if (def instanceof Set) {
    if (!def.has(value as string | boolean | number)) throw typeError(path, def as any, value);
    return value;
  }

  if (typeof def === 'string') {
    if (value === undefined || value === null) return def;
    if (value !== def) throw typeError(path, def, value);
    return value;
  }

  if (typeof def === 'number') {
    const valueType = typeMaskOf(value);

    if ((def & valueType) === 0) {
      if ((def & Mask.UNDEFINED) !== 0) {
        ctx.warn('Invalid value for optional type, defaulting to undefined', {
          value,
          path,
          expected: typeToString(def),
          received: typeToString(valueType),
        });
        return undefined;
      }
      throw typeError(path, def, value);
    }

    if ((def & Mask.HAS_FORMAT) !== 0 && value !== null && value !== undefined) {
      return parseFormattedValue(def, value, ctx, path);
    }

    return value;
  }

  // --- Complex types (ValidatorDef) ---

  const propMask = def.mask;

  const liveConfig = (def as unknown as ValidatorDef<unknown>)._liveConfig;
  if (liveConfig !== undefined && liveConfig.type === LiveFieldType.Value) {
    if (liveConfig.valueType !== undefined) {
      return parseData(value, liveConfig.valueType as unknown as TypeDef, ctx, path);
    }
    return value;
  }

  if ((propMask & Mask.PARSE_RESULT) !== 0) {
    try {
      const innerResult = parseData(value, (def as unknown as ParseResultDef).shape as ComplexTypeDef, ctx, path);
      return { success: true as const, value: innerResult };
    } catch (e) {
      return { success: false as const, error: e instanceof Error ? e : new Error(String(e)) };
    }
  }

  const valueType = typeMaskOf(value);

  if ((propMask & valueType) === 0 && !def.values?.has(value as string | boolean | number)) {
    if ((propMask & Mask.UNDEFINED) !== 0) {
      ctx.warn('Invalid value for optional type, defaulting to undefined', {
        value,
        path,
        expected: typeToString(def as InternalObjectFieldTypeDef),
        received: typeToString(valueType),
      });
      return undefined;
    }
    throw typeError(path, propMask, value);
  }

  if (valueType < Mask.OBJECT) {
    if ((propMask & Mask.HAS_FORMAT) !== 0 && value !== null && value !== undefined) {
      return parseFormattedValue(propMask, value, ctx, path);
    }

    return value;
  }

  if ((propMask & Mask.UNION) !== 0) {
    try {
      return parseUnionData(valueType, value as Record<string, unknown> | unknown[], def as UnionDef, ctx, path);
    } catch (e) {
      // Unknown variant: degrade an optional field to undefined; rethrow a
      // required one so the caller surfaces it instead of dropping silently.
      if (e instanceof UnknownUnionVariantError && (propMask & Mask.UNDEFINED) !== 0) {
        ctx.warn('Unknown union variant for optional field, defaulting to undefined', {
          typename: e.typename,
          path,
        });
        return undefined;
      }
      throw e;
    }
  }

  if (valueType === Mask.ARRAY) {
    return parseArrayData(value as unknown[], (def as ArrayDef).shape as ComplexTypeDef, ctx, path);
  }

  if ((propMask & Mask.RECORD) !== 0) {
    return parseRecordData(value as Record<string, unknown>, (def as RecordDef).shape as ComplexTypeDef, ctx, path);
  }

  if ((propMask & Mask.ENTITY) !== 0 && ctx.queryClient !== undefined) {
    return parseEntityData(value as Record<string, unknown>, def as EntityDef, ctx);
  }

  return parseObjectData(value as Record<string, unknown>, def as ObjectDef | EntityDef, ctx, path);
}

// ======================================================
// Union
// ======================================================

function parseUnionData(
  valueType: number,
  value: Record<string, unknown> | unknown[],
  unionDef: UnionDef,
  ctx: ParseContext,
  path: string,
): unknown {
  if (valueType === Mask.ARRAY) {
    const shape = unionDef.shape![ARRAY_KEY];

    if (shape === undefined || typeof shape === 'number') {
      return value;
    }

    return parseArrayData(value as unknown[], shape as ComplexTypeDef, ctx, path);
  } else {
    const typenameField = unionDef.typenameField;
    const typename = typenameField ? (value as Record<string, unknown>)[typenameField] : undefined;

    if (typename === undefined || typeof typename !== 'string') {
      const recordShape = unionDef.shape![RECORD_KEY];

      if (recordShape === undefined) {
        throw new Error(
          `Typename field '${typenameField}' is required for union discrimination but was not found in the data`,
        );
      }

      return parseRecordData(value as Record<string, unknown>, recordShape as ComplexTypeDef, ctx, path);
    }

    const entry = unionDef.shape![typename];

    if (entry === undefined || typeof entry === 'number') {
      throw new UnknownUnionVariantError(typename, path);
    }

    // Members sharing a typename are grouped by variant; resolve the second
    // level from the payload's variant field.
    let matchingDef: ObjectDef | EntityDef;
    if (entry instanceof VariantGroup) {
      const variantValue = (value as Record<string, unknown>)[entry.variantField];
      const variantDef = typeof variantValue === 'string' ? entry.defs[variantValue] : undefined;

      if (variantDef === undefined) {
        throw new UnknownUnionVariantError(typename, path, String(variantValue));
      }

      matchingDef = variantDef;
    } else {
      matchingDef = entry as ObjectDef | EntityDef;
    }

    if (matchingDef.mask & Mask.ENTITY && ctx.queryClient !== undefined) {
      return parseEntityData(value as Record<string, unknown>, matchingDef as EntityDef, ctx);
    }

    return parseObjectData(value as Record<string, unknown>, matchingDef as ObjectDef | EntityDef, ctx, path);
  }
}

// ======================================================
// Array / Record / Object
// ======================================================

function parseArrayData(array: unknown[], itemShape: ComplexTypeDef, ctx: ParseContext, path: string): unknown[] {
  const result: unknown[] = [];

  for (let i = 0; i < array.length; i++) {
    try {
      result.push(parseData(array[i], itemShape as unknown as TypeDef, ctx, `${path}[${i}]`));
    } catch (e) {
      if (e instanceof CachedEntityMismatchError) throw e;
      ctx.warn('Failed to parse array item, filtering out', {
        index: i,
        value: array[i],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return result;
}

// Both walkers parse into a shallow copy of their input, like `parseArrayData`
// builds a new array. The input belongs to whoever handed it in (an adapter,
// an event payload, a consumer's snapshot — frozen in dev builds) and must not
// be written to; the copy keeps every key the input had, as before.

function parseRecordData(
  record: Record<string, unknown>,
  valueShape: ComplexTypeDef,
  ctx: ParseContext,
  path: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...record };
  for (const [key, value] of entries(record)) {
    result[key] = parseData(value, valueShape as unknown as TypeDef, ctx, `${path}["${key}"]`);
  }

  return result;
}

function parseObjectData(
  obj: Record<string, unknown>,
  objectShape: ObjectDef | EntityDef,
  ctx: ParseContext,
  path: string,
): Record<string, unknown> {
  if (PROXY_ID.has(obj)) {
    return obj;
  }

  const shape = objectShape.shape;
  const result: Record<string, unknown> = { ...obj };

  for (const [key, propShape] of entries(shape)) {
    result[key] = parseData(obj[key], propShape as unknown as TypeDef, ctx, `${path}.${key}`);
  }

  return result;
}

// ======================================================
// Entity — parse into parsed data object, register in seen
// ======================================================

function parseEntityData(
  obj: Record<string, unknown>,
  entityShape: EntityDef,
  ctx: ParseContext,
): Record<string, unknown> {
  const queryClient = ctx.queryClient!;
  const preloadedEntities = ctx.preloadedEntities;
  let key: number;
  let id: string | number;

  if (preloadedEntities !== undefined) {
    key = obj.__entityRef as number;
    // For preloaded entities, the id is embedded in the key. Use key as id
    // since the original value may not survive JSON serialization (symbols).
    id = key;
  } else {
    const rawId = (obj as Record<string | symbol, unknown>)[entityShape.idField];

    if (rawId === undefined || rawId === null || (typeof rawId !== 'string' && typeof rawId !== 'number')) {
      throw new Error(`Entity id must be a string or number: ${entityShape.typenameValue} (got ${typeof rawId})`);
    }

    id = rawId;
    key = hashValue([entityShape.typenameValue, id]);
  }

  const existingEntry = ctx.seenByKey!.get(key);
  if (existingEntry !== undefined) {
    return existingEntry.data;
  }

  const parsedData: Record<string | symbol, unknown> = {};
  // For symbol id fields (QUERY_ID), copy the id onto parsedData so
  // getOrCreateEntity can read it. entries(shape) skips symbol keys.
  if (typeof entityShape.idField === 'symbol') {
    parsedData[entityShape.idField] = id;
  }

  if (preloadedEntities !== undefined) {
    const existing = queryClient.entityMap.getEntity(key);

    // The fields of an entity built from streamed events that the record on
    // disk has and the events did not carry.
    let fillKeys: Set<string> | undefined;
    const preloaded = preloadedEntities.get(key);

    if (existing !== undefined && existing._partial && existing._partialKeys !== undefined && preloaded !== undefined) {
      // Built from events, the in-memory data lacks what the record has:
      // parse the record for those fields only and merge them in.
      fillKeys = existing._partialKeys;
      obj = preloaded;
    } else if (existing !== undefined) {
      // The entity is already live in memory, so the cache has nothing newer
      // to offer: the in-memory data is what every consumer already sees.
      // Re-parsing that data would run already-parsed values (formatted
      // values, parse results, child proxies) through the parser again, in
      // place, and corrupt them. An empty partial entry merges nothing and
      // hands the query the existing proxy. The data must still satisfy this
      // query's shape, or the cached query is not usable as-is.
      ctx.trusted ??= new Map();
      if (!dataSatisfiesDef(existing.data, entityShape as unknown as ValidatorDef<unknown>, queryClient, ctx.trusted)) {
        throw new CachedEntityMismatchError(
          `Cached entity ${entityShape.typenameValue}:${String(existing.id)} in memory does not satisfy the query's shape`,
        );
      }
      const entry: ParsedEntity = {
        key,
        shape: entityShape,
        data: parsedData,
        rawKeys: new Set(),
        eventKeys: undefined,
        fillsPartial: false,
      };
      ctx.seen!.set(parsedData, entry);
      ctx.seenByKey!.set(key, entry);
      return parsedData;
    } else {
      if (preloaded === undefined) {
        throw new Error(`Cached entity ${key} not found in preloaded map`);
      }
      obj = preloaded;
    }

    if (fillKeys !== undefined) {
      const shapeKeys = Object.keys(entityShape.shape);
      const rawKeys = new Set<string>();
      for (const k of shapeKeys) if (!fillKeys.has(k)) rawKeys.add(k);
      const entry: ParsedEntity = {
        key,
        shape: entityShape,
        data: parsedData,
        rawKeys,
        eventKeys: undefined,
        fillsPartial: true,
      };
      ctx.seen!.set(parsedData, entry);
      ctx.seenByKey!.set(key, entry);
      const entityDesc = `[[${entityShape.typenameValue}:${id}]]`;
      for (const [fieldKey, propShape] of entries(entityShape.shape)) {
        if (!rawKeys.has(fieldKey)) continue;
        parsedData[fieldKey] = parseData(
          obj[fieldKey],
          propShape as unknown as TypeDef,
          ctx,
          `${entityDesc}.${fieldKey}`,
        );
      }
      return parsedData;
    }
  }
  // For mutation events updating existing entities, track which keys are
  // present so mergeFields only touches those fields (true partial update).
  const existingInStore = queryClient.entityMap.getEntity(key);
  const isPartial = ctx.isPartialEvent && existingInStore !== undefined;

  const eventKeys = ctx.isPartialEvent ? new Set(Object.keys(obj)) : undefined;
  const entry: ParsedEntity = {
    key,
    shape: entityShape,
    data: parsedData,
    rawKeys: isPartial ? eventKeys : undefined,
    eventKeys,
    fillsPartial: false,
  };
  ctx.seen!.set(parsedData, entry);
  ctx.seenByKey!.set(key, entry);

  const entityDesc = `[[${entityShape.typenameValue}:${id}]]`;
  const shape = entityShape.shape;

  for (const [fieldKey, propShape] of entries(shape)) {
    // For partial event updates (mutation events), skip fields not in the payload.
    if (isPartial && !(fieldKey in obj)) continue;
    // For full responses (queries/mutations), always parse every field —
    // missing fields are treated as undefined (JSON drops undefined values).
    parsedData[fieldKey] = parseData(obj[fieldKey], propShape as unknown as TypeDef, ctx, `${entityDesc}.${fieldKey}`);
  }

  return parsedData;
}

// ======================================================
// entitySatisfiesShape
// ======================================================

/**
 * Whether already-parsed entity data can be handed to a query declaring `def`
 * without being parsed again. Unlike `entitySatisfiesShape` (a top-level
 * presence check used for narrowing) this descends into nested objects, arrays,
 * records, unions and child entities, because a cached query that resolves with
 * a required nested field missing is worse than one that refetches. Where a
 * value cannot be judged it is accepted, matching the parser's leniency.
 */
export function dataSatisfiesDef(
  data: Record<string, unknown>,
  def: ValidatorDef<unknown>,
  queryClient: QueryClient,
  visiting: TrustMemo,
): boolean {
  const shape = def.shape as Record<string, unknown> | undefined;
  if (shape === undefined || shape === null) return true;
  for (const key of Object.keys(shape)) {
    if (key === def.typenameField) continue;
    if (!valueSatisfiesDef(data[key], shape[key], queryClient, visiting)) return false;
  }
  return true;
}

function allowsMissing(mask: number): boolean {
  return (mask & Mask.UNDEFINED) !== 0;
}

function maskOf(value: unknown): number {
  switch (typeof value) {
    case 'number':
      return Mask.NUMBER;
    case 'string':
      return Mask.STRING;
    case 'boolean':
      return Mask.BOOLEAN;
    case 'undefined':
      return Mask.UNDEFINED;
    case 'object':
      return value === null ? Mask.NULL : Array.isArray(value) ? Mask.ARRAY : Mask.OBJECT;
    default:
      return 0;
  }
}

function valueSatisfiesDef(value: unknown, fieldDef: unknown, queryClient: QueryClient, visiting: TrustMemo): boolean {
  // Literals: the parser fills a missing literal in, and rejects any other value.
  if (fieldDef instanceof VariantSet) return value === fieldDef.value;
  if (typeof fieldDef === 'string') return value === fieldDef;
  if (fieldDef instanceof Set) return fieldDef.has(value as never);

  if (typeof fieldDef === 'number') {
    if (value === undefined) return allowsMissing(fieldDef);
    if (value === null) return (fieldDef & Mask.NULL) !== 0;
    if ((fieldDef & Mask.HAS_FORMAT) !== 0) return value instanceof FormattedValue;
    return (fieldDef & maskOf(value)) !== 0;
  }

  if (!(fieldDef instanceof ValidatorDef)) return true;
  const mask = fieldDef.mask;
  if (value === undefined) return allowsMissing(mask);
  if (value === null) return (mask & Mask.NULL) !== 0;

  if (fieldDef._liveConfig !== undefined) return true;
  if ((mask & Mask.PARSE_RESULT) !== 0) return typeof value === 'object' && 'success' in (value as object);
  if (typeof value !== 'object') {
    if ((mask & Mask.HAS_FORMAT) !== 0 && (mask & maskOf(value)) !== 0) return false;
    return (mask & maskOf(value)) !== 0 || fieldDef.values?.has(value as never) === true;
  }
  if (value instanceof FormattedValue) return (mask & Mask.HAS_FORMAT) !== 0;

  if ((mask & Mask.ENTITY) !== 0 && (mask & Mask.UNION) === 0) {
    return entitySatisfies(value as object, fieldDef, queryClient, visiting);
  }

  if ((mask & Mask.UNION) !== 0) {
    // Resolve the member the value belongs to; an unrecognised value is left
    // to the union's own leniency.
    const members = fieldDef.shape as Record<string | symbol, unknown> | undefined;
    if (members === undefined || members === null) return true;
    if (Array.isArray(value)) {
      const itemDef = members[ARRAY_KEY];
      if (itemDef === undefined || typeof itemDef === 'number') return true;
      return arraySatisfies(value, itemDef, queryClient, visiting);
    }
    const entityKey = PROXY_ID.get(value as object);
    const typename =
      entityKey !== undefined
        ? queryClient.entityMap.getEntity(entityKey)?.typename
        : ((value as Record<string, unknown>)[fieldDef.typenameField ?? '__typename'] as string | undefined);
    const member = typename !== undefined ? members[typename] : undefined;
    if (member instanceof VariantGroup) {
      const source =
        entityKey !== undefined ? queryClient.entityMap.getEntity(entityKey)?.data : (value as Record<string, unknown>);
      const variant = source?.[member.variantField] as string | undefined;
      const variantDef = variant !== undefined ? member.defs[variant] : undefined;
      return variantDef === undefined ? true : valueSatisfiesDef(value, variantDef, queryClient, visiting);
    }
    if (member === undefined || typeof member === 'number') {
      const recordDef = members[RECORD_KEY];
      if (typename !== undefined || recordDef === undefined || entityKey !== undefined) return true;
      for (const item of Object.values(value as Record<string, unknown>)) {
        if (!valueSatisfiesDef(item, recordDef, queryClient, visiting)) return false;
      }
      return true;
    }
    return valueSatisfiesDef(value, member, queryClient, visiting);
  }

  if ((mask & Mask.ARRAY) !== 0) {
    if (!Array.isArray(value)) return false;
    return arraySatisfies(value, fieldDef.shape, queryClient, visiting);
  }

  if ((mask & Mask.RECORD) !== 0) {
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    for (const item of Object.values(value as Record<string, unknown>)) {
      if (!valueSatisfiesDef(item, fieldDef.shape, queryClient, visiting)) return false;
    }
    return true;
  }

  if ((mask & Mask.OBJECT) !== 0) {
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    if (PROXY_ID.has(value as object)) return true;
    return dataSatisfiesDef(value as Record<string, unknown>, fieldDef, queryClient, visiting);
  }

  return (mask & maskOf(value)) !== 0;
}

/**
 * An entity field holds a proxy. One whose instance has left memory is served
 * as it is (the data it still holds), as a re-parse would have handed it out
 * too; a live one must satisfy the def, with verdicts shared across the parse
 * and a cycle counted as satisfied.
 */
function entitySatisfies(
  value: object,
  def: ValidatorDef<unknown>,
  queryClient: QueryClient,
  visiting: TrustMemo,
): boolean {
  const entityKey = PROXY_ID.get(value);
  if (entityKey === undefined) return false;
  const child = queryClient.entityMap.getEntity(entityKey);
  if (child === undefined) return true;
  let checked = visiting.get(child);
  if (checked === undefined) visiting.set(child, (checked = new Map()));
  const known = checked.get(def);
  if (known !== undefined) return known === 'pending' || known;
  checked.set(def, 'pending');
  const verdict = dataSatisfiesDef(child.data, def, queryClient, visiting);
  checked.set(def, verdict);
  return verdict;
}

/**
 * Members of an entity array whose typename has more than one registered
 * class are narrowed on read to the ones satisfying the field's def, so a
 * member that does not satisfy it is not a mismatch: it is left out either
 * way.
 */
function arraySatisfies(value: unknown[], itemDef: unknown, queryClient: QueryClient, visiting: TrustMemo): boolean {
  let narrowed = false;
  if (itemDef instanceof ValidatorDef && (itemDef.mask & Mask.ENTITY) !== 0 && (itemDef.mask & Mask.UNION) === 0) {
    const typename = itemDef.typenameValue;
    const defs = typename !== undefined ? queryClient.getEntityDefsForTypename(typename) : undefined;
    narrowed = defs !== undefined && defs.length > 1;
  }
  for (const item of value) {
    if (valueSatisfiesDef(item, itemDef, queryClient, visiting)) continue;
    if (narrowed && typeof item === 'object' && item !== null && PROXY_ID.has(item)) continue;
    return false;
  }
  return true;
}

export function entitySatisfiesShape(data: Record<string, unknown>, def: ValidatorDef<any>): boolean {
  return objectSatisfiesShape(data, def.shape as Record<string, unknown>, def.typenameField);
}

function objectSatisfiesShape(
  data: Record<string, unknown>,
  shape: Record<string, unknown> | undefined,
  typenameField?: string,
): boolean {
  if (shape === undefined) return true;

  for (const key of Object.keys(shape)) {
    if (key === typenameField) continue;

    const fieldDef = shape[key];

    // A variant tag must match by value: an entity of one variant does not
    // satisfy a sibling variant's shape even when field profiles overlap.
    if (fieldDef instanceof VariantSet) {
      if (data[key] !== fieldDef.value) return false;
      continue;
    }

    if (fieldDef instanceof ValidatorDef) {
      if ((fieldDef.mask & Mask.UNDEFINED) !== 0) continue;
      if (!(key in data) || data[key] === undefined) return false;
    } else if (typeof fieldDef === 'number') {
      if ((fieldDef & Mask.UNDEFINED) !== 0) continue;
      if (!(key in data) || data[key] === undefined) return false;
    } else {
      if (!(key in data) || data[key] === undefined) return false;
    }
  }
  return true;
}
