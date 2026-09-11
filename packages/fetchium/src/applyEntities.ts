// -----------------------------------------------------------------------------
// Apply Entities
//
// Single depth-first walk from the root that applies parsed entities to the
// entity store, replaces parsed data objects with entity proxies, and counts
// child refs. Entity fields are reified inline during the merge/init loops
// so there is only one iteration per entity's shape fields.
// -----------------------------------------------------------------------------

import type { QueryClient } from './QueryClient.js';
import type { EntityInstance } from './EntityInstance.js';
import type { ParseContext, ParsedEntity } from './parseEntities.js';
import { FormattedValue, ValidatorDef } from './typeDefs.js';
import { Mask } from './types.js';
import { createLiveCollection, LiveCollectionBinding } from './LiveCollection.js';
import { PROXY_ID } from './proxyId.js';

const entries = Object.entries;
const ObjectProto = Object.prototype;

// ======================================================
// Public API
// ======================================================

export interface ApplyResult {
  data: unknown;
  entityRefs: Map<EntityInstance, number>;
}

/**
 * Single depth-first walk from the root that applies entities to the store,
 * replaces parsed data objects with entity proxies, and counts child refs.
 */
export function applyEntityRefs(
  ctx: ParseContext,
  rootData: unknown,
  persist: boolean,
  appendMode: boolean = false,
): ApplyResult {
  const queryClient = ctx.queryClient!;
  queryClient.currentParseId++;

  const seen = ctx.seen!;
  const entityRefs = new Map<EntityInstance, number>();
  const data = reifyAndApply(rootData, seen, queryClient, persist, entityRefs, appendMode);

  return { data, entityRefs };
}

// ======================================================
// Depth-first walk
// ======================================================

function reifyAndApply(
  value: unknown,
  seen: Map<Record<string, unknown>, ParsedEntity>,
  queryClient: QueryClient,
  persist: boolean,
  entityRefs: Map<EntityInstance, number>,
  appendMode: boolean,
): unknown {
  if (typeof value !== 'object' || value === null) return value;

  const entity = seen.get(value as Record<string, unknown>);
  if (entity !== undefined) {
    return applyEntity(entity, seen, queryClient, persist, entityRefs, appendMode);
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (typeof item === 'object' && item !== null && !(item instanceof FormattedValue) && !PROXY_ID.has(item)) {
        value[i] = reifyAndApply(item, seen, queryClient, persist, entityRefs, appendMode);
      }
    }
    return value;
  }

  if (Object.getPrototypeOf(value) === ObjectProto && !PROXY_ID.has(value as object)) {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (typeof v === 'object' && v !== null && !(v instanceof FormattedValue) && !PROXY_ID.has(v)) {
        obj[key] = reifyAndApply(v, seen, queryClient, persist, entityRefs, appendMode);
      }
    }
  }

  return value;
}

function shouldReify(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !(v instanceof FormattedValue) && !PROXY_ID.has(v);
}

// ======================================================
// Entity apply — reify fields + merge data + wire child refs
// ======================================================

function applyEntity(
  entity: ParsedEntity,
  seen: Map<Record<string, unknown>, ParsedEntity>,
  queryClient: QueryClient,
  persist: boolean,
  parentEntityRefs: Map<EntityInstance, number>,
  appendMode: boolean,
): Record<string, unknown> {
  const { key, data, shape: entityShape, rawKeys } = entity;
  const shapeFields = entityShape.shape;

  const entityInstance = queryClient.prepareEntity(key, data, entityShape);
  const existingData = entityInstance.data;
  const isUpdate = existingData !== data;

  // For partial updates (rawKeys defined), seed childRefs with existing refs
  // so unchanged entity-ref fields aren't released by setChildRefs.
  const childRefs =
    isUpdate && rawKeys !== undefined && entityInstance.entityRefs !== undefined
      ? new Map(entityInstance.entityRefs)
      : new Map<EntityInstance, number>();

  // A refetch or a poll that returns identical data is a no-op: nothing to
  // notify consumers about, and nothing new to write to the store.
  let changed = true;
  if (isUpdate) {
    changed = mergeFields(
      shapeFields,
      data,
      existingData,
      rawKeys,
      entityInstance,
      existingData,
      seen,
      queryClient,
      persist,
      childRefs,
      appendMode,
    );
    if (changed) entityInstance.notify();
  } else {
    initFields(shapeFields, data, entityInstance, data, seen, queryClient, persist, childRefs, appendMode);
  }

  if (appendMode && entityInstance.liveCollections.length > 0) {
    for (const binding of entityInstance.liveCollections) {
      const raw = binding.instance.getRawValue();
      if (!Array.isArray(raw)) continue;
      for (const item of raw) {
        if (typeof item !== 'object' || item === null) continue;
        const itemKey = PROXY_ID.get(item as object);
        if (itemKey === undefined) continue;
        const child = queryClient.entityMap.getEntity(itemKey);
        if (child !== undefined) {
          childRefs.set(child, (childRefs.get(child) ?? 0) + 1);
        }
      }
    }
  }

  const newRefs = childRefs.size > 0 ? childRefs : undefined;
  const refsChanged = !sameRefs(entityInstance.entityRefs, newRefs);
  // An entity hydrated from the store was never written, so there is no write to skip.
  const needsPersist = changed || refsChanged || !entityInstance._persisted;
  entityInstance.setChildRefs(newRefs, persist && needsPersist);

  const proxy = entityInstance.getProxy(entityShape);

  parentEntityRefs.set(entityInstance, (parentEntityRefs.get(entityInstance) ?? 0) + 1);

  return proxy;
}

// ======================================================
// Field merge (update path) — reify + merge in one loop
// ======================================================

function mergeFields(
  shape: Record<string, unknown>,
  data: Record<string, unknown>,
  existingData: Record<string, unknown>,
  rawKeys: Set<string> | undefined,
  entityInstance: EntityInstance,
  entityData: Record<string, unknown>,
  seen: Map<Record<string, unknown>, ParsedEntity>,
  queryClient: QueryClient,
  persist: boolean,
  childRefs: Map<EntityInstance, number>,
  appendMode: boolean,
): boolean {
  let changed = false;
  for (const [fieldKey, propShape] of entries(shape)) {
    if (rawKeys !== undefined && !rawKeys.has(fieldKey)) continue;

    if (shouldReify(data[fieldKey])) {
      data[fieldKey] = reifyAndApply(data[fieldKey], seen, queryClient, persist, childRefs, appendMode);
    }

    if (propShape instanceof ValidatorDef && propShape._liveConfig !== undefined) {
      const existingValue = existingData[fieldKey];
      if (existingValue instanceof LiveCollectionBinding) {
        if (appendMode ? existingValue.append(data[fieldKey]) : existingValue.reset(data[fieldKey])) {
          changed = true;
        }
      } else {
        existingData[fieldKey] = createLiveCollection(
          propShape._liveConfig,
          data[fieldKey],
          entityInstance,
          entityData,
          queryClient,
        );
        changed = true;
      }
    } else {
      const newVal = data[fieldKey];
      const oldVal = existingData[fieldKey];
      if (newVal === oldVal) continue;
      // Replace a union wholesale instead of merging by field, otherwise a
      // changed variant keeps the old variant's fields. Unlike entity unions,
      // there is no partial-update path to preserve here: a partial variant
      // payload fails validation, so every update carries the full variant.
      const isUnion = propShape instanceof ValidatorDef && (propShape.mask & Mask.UNION) !== 0;
      if (!isUnion && isPlainObject(newVal) && isPlainObject(oldVal)) {
        // Only an object/entity def carries a record of field defs. A record
        // def's shape is its *value* type — a bare `Mask` for `t.record(t.string)`
        // — and recursing into that iterated `Object.entries(8)`, merged
        // nothing, and then restored the old value: record fields never
        // applied an update, an addition or a removal.
        const nestedShape =
          propShape instanceof ValidatorDef &&
          propShape.shape !== undefined &&
          typeof propShape.shape === 'object' &&
          !(propShape.shape instanceof ValidatorDef) &&
          !(propShape.shape instanceof Set)
            ? (propShape.shape as Record<string, unknown>)
            : undefined;
        if (nestedShape !== undefined) {
          if (
            mergeFields(
              nestedShape,
              newVal,
              oldVal,
              undefined,
              entityInstance,
              entityData,
              seen,
              queryClient,
              persist,
              childRefs,
              appendMode,
            )
          ) {
            changed = true;
          }
          existingData[fieldKey] = oldVal;
        } else if (sameKeys(oldVal, newVal)) {
          // Shapeless object (e.g. a record) with the same keys: copy field by field, keeping the
          // existing value — and its identity — wherever it already matches.
          for (const k of Object.keys(newVal)) {
            if (!sameValue(oldVal[k], newVal[k])) {
              oldVal[k] = newVal[k];
              changed = true;
            }
          }
          existingData[fieldKey] = oldVal;
        } else {
          // A key was added or removed. Copying field by field would never
          // apply a removal, leaving the old key in `data` indefinitely.
          existingData[fieldKey] = newVal;
          changed = true;
        }
      } else if (!sameValue(oldVal, newVal)) {
        // Otherwise the existing value stays, so its identity survives.
        existingData[fieldKey] = newVal;
        changed = true;
      }
    }
  }
  return changed;
}

/** Whether both records have the same set of own keys. */
export function sameKeys(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (!Object.hasOwn(b, aKeys[i])) return false;
  }
  return true;
}

/**
 * Structural equality for parsed field values. Entity proxies compare by
 * identity (one proxy per entity and shape), formatted values by the raw input
 * they were built from, arrays and plain objects element by element.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (a instanceof FormattedValue || b instanceof FormattedValue) {
    return a instanceof FormattedValue && b instanceof FormattedValue && a._raw === b._raw;
  }
  // Distinct proxies are distinct entities, and anything else exotic (a Date, a
  // live collection binding, a class instance) is not safely comparable.
  if (PROXY_ID.has(a) || PROXY_ID.has(b)) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!sameValue(a[i], b[i])) return false;
    }
    return true;
  }
  if (Object.getPrototypeOf(a) !== ObjectProto || Object.getPrototypeOf(b) !== ObjectProto) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    const key = aKeys[i];
    // `hasOwn`, not `in`: `in` reaches the prototype, so a key missing from `b`
    // can be answered by `Object.prototype` and compared against instead.
    if (!Object.hasOwn(b, key)) return false;
    if (!sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/**
 * Compares the ref *key set*, which is what a write would change: the store
 * persists `refKeys` with no counts, and `setChildRefs` retains and releases on
 * a key appearing or disappearing. Comparing counts would force a write that
 * produced byte-identical bytes.
 */
export function sameRefs(
  a: Map<EntityInstance, number> | undefined,
  b: Map<EntityInstance, number> | undefined,
): boolean {
  const aSize = a === undefined ? 0 : a.size;
  const bSize = b === undefined ? 0 : b.size;
  if (aSize !== bSize) return false;
  if (aSize === 0) return true;
  for (const entity of a!.keys()) {
    if (!b!.has(entity)) return false;
  }
  return true;
}

// ======================================================
// Field init (new entity path) — reify + create live data in one loop
// ======================================================

function initFields(
  shape: Record<string, unknown>,
  data: Record<string, unknown>,
  entityInstance: EntityInstance,
  entityData: Record<string, unknown>,
  seen: Map<Record<string, unknown>, ParsedEntity>,
  queryClient: QueryClient,
  persist: boolean,
  childRefs: Map<EntityInstance, number>,
  appendMode: boolean,
): void {
  for (const [fieldKey, propShape] of entries(shape)) {
    if (!(fieldKey in data)) continue;

    if (shouldReify(data[fieldKey])) {
      data[fieldKey] = reifyAndApply(data[fieldKey], seen, queryClient, persist, childRefs, appendMode);
    }

    if (propShape instanceof ValidatorDef && propShape._liveConfig !== undefined) {
      data[fieldKey] = createLiveCollection(
        propShape._liveConfig,
        data[fieldKey],
        entityInstance,
        entityData,
        queryClient,
      );
    } else {
      const val = data[fieldKey];
      if (isPlainObject(val)) {
        // Only an object/entity def carries a record of field defs. A record
        // def's shape is its *value* type — a bare `Mask` for `t.record(t.string)`
        // — and recursing into that iterated `Object.entries(8)`, merged
        // nothing, and then restored the old value: record fields never
        // applied an update, an addition or a removal.
        const nestedShape =
          propShape instanceof ValidatorDef &&
          propShape.shape !== undefined &&
          typeof propShape.shape === 'object' &&
          !(propShape.shape instanceof ValidatorDef) &&
          !(propShape.shape instanceof Set)
            ? (propShape.shape as Record<string, unknown>)
            : undefined;
        if (nestedShape !== undefined) {
          initFields(nestedShape, val, entityInstance, entityData, seen, queryClient, persist, childRefs, appendMode);
        }
      }
    }
  }
}

// ======================================================
// Helpers
// ======================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === ObjectProto &&
    !PROXY_ID.has(v)
  );
}
