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
import { type EntityDef, Mask } from './types.js';
import { createLiveCollection, LiveCollectionBinding } from './LiveCollection.js';
import { PROXY_ID } from './proxyId.js';
import { dropNestedWrapper } from './nestedNotifiers.js';

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
 * Whether an apply writes to the store. `true` writes every entity that needs
 * it, and `false` writes nothing (cache hydration). `'existing'` writes only
 * entities already in memory. Ones this apply creates are written when a
 * written record references them (`EntityInstance.save` writes missing
 * children first), or by the caller once it knows the root is retained.
 */
export type PersistMode = boolean | 'existing';

/**
 * Single depth-first walk from the root that applies entities to the store,
 * replaces parsed data objects with entity proxies, and counts child refs.
 */
export function applyEntityRefs(
  ctx: ParseContext,
  rootData: unknown,
  persist: PersistMode,
  appendMode: boolean = false,
  created?: Set<EntityInstance>,
): ApplyResult {
  const queryClient = ctx.queryClient!;
  queryClient.currentParseId++;

  const seen = ctx.seen!;
  const entityRefs = new Map<EntityInstance, number>();
  let data: unknown;
  try {
    data = reifyAndApply(rootData, seen, queryClient, persist, entityRefs, appendMode, created);
  } catch (e) {
    queryClient.discardDeferredWrites();
    throw e;
  }

  // Entities a written record referenced while they were still being reified
  // (a payload that links back to an ancestor) are complete now, and so are
  // the records that reference them.
  queryClient.flushDeferredWrites();

  return { data, entityRefs };
}

// ======================================================
// Depth-first walk
// ======================================================

function reifyAndApply(
  value: unknown,
  seen: Map<Record<string, unknown>, ParsedEntity>,
  queryClient: QueryClient,
  persist: PersistMode,
  entityRefs: Map<EntityInstance, number>,
  appendMode: boolean,
  created: Set<EntityInstance> | undefined,
): unknown {
  if (typeof value !== 'object' || value === null) return value;

  const entity = seen.get(value as Record<string, unknown>);
  if (entity !== undefined) {
    return applyEntity(entity, seen, queryClient, persist, entityRefs, appendMode, created);
  }

  // Assign only slots whose value changes: values the parser did not declare
  // (and so did not copy) may belong to the caller and be frozen.
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (typeof item === 'object' && item !== null && !(item instanceof FormattedValue) && !PROXY_ID.has(item)) {
        const reified = reifyAndApply(item, seen, queryClient, persist, entityRefs, appendMode, created);
        if (reified !== item) value[i] = reified;
      }
    }
    return value;
  }

  if (Object.getPrototypeOf(value) === ObjectProto && !PROXY_ID.has(value as object)) {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (typeof v === 'object' && v !== null && !(v instanceof FormattedValue) && !PROXY_ID.has(v)) {
        const reified = reifyAndApply(v, seen, queryClient, persist, entityRefs, appendMode, created);
        if (reified !== v) obj[key] = reified;
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
  persist: PersistMode,
  parentEntityRefs: Map<EntityInstance, number>,
  appendMode: boolean,
  created: Set<EntityInstance> | undefined,
): Record<string, unknown> {
  const { key, data, shape: entityShape, rawKeys, eventKeys, fillsPartial, record } = entity;
  const shapeFields = entityShape.shape;

  // An entity can appear in several slots of one payload (under `author` and
  // `mentions`), all sharing one parsed object. Applying it again would find
  // its children already reified, count none and release every child ref, so
  // only count this slot's reference.
  const applied = queryClient.entityMap.getEntity(key);
  if (applied !== undefined && applied.parseId === queryClient.currentParseId) {
    parentEntityRefs.set(applied, (parentEntityRefs.get(applied) ?? 0) + 1);
    return applied.getProxy(entityShape);
  }

  const entityInstance = queryClient.prepareEntity(key, data, entityShape, applied);
  const existingData = entityInstance.data;
  const isUpdate = existingData !== data;

  // For partial updates (rawKeys defined), seed childRefs with existing refs
  // so unchanged entity-ref fields aren't released by setChildRefs.
  const childRefs =
    isUpdate && rawKeys !== undefined && entityInstance.entityRefs !== undefined
      ? new Map(entityInstance.entityRefs)
      : new Map<EntityInstance, number>();
  // A refetch or poll that returns identical data neither notifies nor writes.
  let changed = true;
  // Until the fields are reified the data is not a record yet: a write that
  // reaches this instance through a reference from inside its own subtree is
  // deferred to the end of the walk.
  entityInstance._applying = true;
  try {
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
        created,
      );
      if ((persist === true && rawKeys === undefined) || fillsPartial) {
        // A full payload (a fetch), or the record's fields merged in, makes
        // the data a complete record again.
        if (entityInstance._partial && !fillsPartial) checkStoredRecord(entityInstance, entityShape, queryClient);
        entityInstance._partial = false;
        entityInstance._partialKeys = undefined;
      } else if (entityInstance._partial && rawKeys !== undefined) {
        const partialKeys = entityInstance._partialKeys!;
        for (const k of rawKeys) partialKeys.add(k);
        if (eventsBuiltWholeRecord(partialKeys, entityShape, queryClient)) {
          entityInstance._partial = false;
          entityInstance._partialKeys = undefined;
        }
      }
    } else {
      initFields(shapeFields, data, entityInstance, data, seen, queryClient, persist, childRefs, appendMode, created);
      if (eventKeys !== undefined) {
        // Streamed events are partial: what this entity holds is what its
        // events carried, not necessarily the whole record.
        entityInstance._partial = true;
        entityInstance._partialKeys = new Set(eventKeys);
        // A record always carries its typename and id, whether or not the
        // event did (the parser fills the literal in).
        if (entityShape.typenameField !== undefined) entityInstance._partialKeys.add(entityShape.typenameField);
        if (typeof entityShape.idField === 'string') entityInstance._partialKeys.add(entityShape.idField);
        if (eventsBuiltWholeRecord(entityInstance._partialKeys, entityShape, queryClient)) {
          entityInstance._partial = false;
          entityInstance._partialKeys = undefined;
        }
      } else if (persist === false) {
        // Hydrated from the store: its record exists.
        entityInstance._recorded = true;
      } else if (persist === true && record === undefined) {
        checkStoredRecord(entityInstance, entityShape, queryClient);
      }
      if (persist === 'existing') created?.add(entityInstance);
    }
  } finally {
    entityInstance._applying = false;
  }
  // Fields only another class declares stay in the data. Count their refs or
  // they get released while that class's consumers still show them.
  const heldRefs = entityInstance.entityRefs;
  let keepsHeldRefs = false;
  if (
    isUpdate &&
    rawKeys === undefined &&
    heldRefs !== undefined &&
    queryClient.hasForeignFieldDefs &&
    queryClient.mayMissForeignFields(entityShape as unknown as ValidatorDef<unknown>)
  ) {
    if (!changed && !appendMode && entityInstance._refsCounted) {
      keepsHeldRefs = true;
    } else {
      const fields = queryClient.foreignRefFields(entityShape as unknown as ValidatorDef<unknown>);
      for (let i = 0; i < fields.length; i++) countHeldRefs(existingData[fields[i]], heldRefs, childRefs, queryClient);
    }
  }
  entityInstance._refsCounted = rawKeys === undefined && !appendMode;
  if (isUpdate && changed) entityInstance.notify();
  if (record !== undefined) {
    entityInstance.recordHoldsOtherFields(record, queryClient.entityMap.readEntity !== undefined);
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

  const newRefs = keepsHeldRefs ? heldRefs : childRefs.size > 0 ? childRefs : undefined;
  const refsChanged = !sameRefs(entityInstance.entityRefs, newRefs);
  // An entity hydrated from the store was never written, so there is no write
  // to skip. One with a write still queued has its current data on the way.
  // Skipping is only safe while the store has no deletion queued, which could
  // drop the record this apply trusts.
  const needsPersist =
    changed ||
    refsChanged ||
    (!entityInstance._persisted && entityInstance._pendingWrites === 0) ||
    !queryClient.storeReportsDeletes ||
    !queryClient.storeIsSettled();
  const writes = persist === true || (persist === 'existing' && isUpdate);
  entityInstance.setChildRefs(newRefs, writes && needsPersist);

  const proxy = entityInstance.getProxy(entityShape);

  parentEntityRefs.set(entityInstance, (parentEntityRefs.get(entityInstance) ?? 0) + 1);

  return proxy;
}

function countHeldRefs(
  value: unknown,
  held: Map<EntityInstance, number>,
  childRefs: Map<EntityInstance, number>,
  queryClient: QueryClient,
): void {
  if (typeof value !== 'object' || value === null || value instanceof FormattedValue) return;
  const key = PROXY_ID.get(value);
  if (key !== undefined) {
    const child = queryClient.entityMap.getEntity(key);
    if (child !== undefined && held.has(child)) childRefs.set(child, (childRefs.get(child) ?? 0) + 1);
    return;
  }
  if (value instanceof LiveCollectionBinding) {
    countHeldRefs(value.instance.getRawValue(), held, childRefs, queryClient);
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) countHeldRefs(value[i], held, childRefs, queryClient);
  } else if (Object.getPrototypeOf(value) === ObjectProto) {
    const obj = value as Record<string, unknown>;
    for (const k of Object.keys(obj)) countHeldRefs(obj[k], held, childRefs, queryClient);
  }
}

/** The fetch replaces the whole record, so the first write must read it to keep other classes' fields. */
function checkStoredRecord(instance: EntityInstance, shape: EntityDef, queryClient: QueryClient): void {
  if (
    queryClient.hasForeignFieldDefs &&
    !instance.keepsRecordFields() &&
    queryClient.mayMissForeignFields(shape as unknown as ValidatorDef<unknown>)
  ) {
    instance._checkStoredRecord = true;
  }
}

/**
 * Whether streamed fields make a whole record that can be written instead of
 * merged. Without `storeKnowsTypenameFields` an unregistered class may own
 * fields in the record, so it stays partial.
 */
function eventsBuiltWholeRecord(keys: Set<string>, entityShape: EntityDef, queryClient: QueryClient): boolean {
  for (const k in entityShape.shape) if (!keys.has(k)) return false;
  if (!queryClient.storeKnowsTypenameFields) return false;
  return (
    !queryClient.hasForeignFieldDefs ||
    !queryClient.mayMissForeignFields(entityShape as unknown as ValidatorDef<unknown>)
  );
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
  persist: PersistMode,
  childRefs: Map<EntityInstance, number>,
  appendMode: boolean,
  created: Set<EntityInstance> | undefined,
): boolean {
  let changed = false;
  for (const [fieldKey, propShape] of entries(shape)) {
    if (rawKeys !== undefined && !rawKeys.has(fieldKey)) continue;

    const raw = data[fieldKey];
    if (shouldReify(raw)) {
      // Assign only on change: an object the parser kept as is (from a fetch
      // result) may belong to the adapter and be frozen.
      const reified = reifyAndApply(raw, seen, queryClient, persist, childRefs, appendMode, created);
      if (reified !== raw) data[fieldKey] = reified;
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
          fieldKey,
        );
        changed = true;
      }
    } else {
      const newVal = data[fieldKey];
      const oldVal = existingData[fieldKey];
      if (Object.is(newVal, oldVal)) continue;
      // Replace a union wholesale instead of merging by field, otherwise a
      // changed variant keeps the old variant's fields. Unlike entity unions,
      // there is no partial-update path to preserve here: a partial variant
      // payload fails validation, so every update carries the full variant.
      const isUnion = propShape instanceof ValidatorDef && (propShape.mask & Mask.UNION) !== 0;
      if (!isUnion && isPlainObject(newVal) && isPlainObject(oldVal)) {
        // Only object/entity defs have a record of field defs as their shape.
        // A record def's shape is its value type (a bare `Mask` for
        // `t.record(t.string)`), which must not be recursed into as fields.
        const nestedShape =
          propShape instanceof ValidatorDef &&
          propShape.shape !== undefined &&
          typeof propShape.shape === 'object' &&
          !(propShape.shape instanceof ValidatorDef) &&
          !(propShape.shape instanceof Set)
            ? (propShape.shape as Record<string, unknown>)
            : undefined;
        // An unchanged object kept from a fetch result may be frozen by the
        // adapter: merge into a copy.
        const target = Object.isFrozen(oldVal) ? { ...oldVal } : oldVal;
        if (nestedShape !== undefined) {
          if (
            mergeFields(
              nestedShape,
              newVal,
              target,
              undefined,
              entityInstance,
              entityData,
              seen,
              queryClient,
              persist,
              childRefs,
              appendMode,
              created,
            )
          ) {
            changed = true;
            // Merged in place, so the value keeps its identity. Drop its
            // wrapper so a child given just this value as a prop sees a new
            // one. A merged copy is already a new value.
            if (target === oldVal) dropNestedWrapper(oldVal);
            existingData[fieldKey] = target;
          } else {
            existingData[fieldKey] = oldVal;
          }
        } else if (sameKeys(oldVal, newVal)) {
          // Shapeless object (e.g. a record) with the same keys: copy field by field, keeping the
          // existing value — and its identity — wherever it already matches.
          let merged = false;
          for (const k of Object.keys(newVal)) {
            if (!sameValue(oldVal[k], newVal[k])) {
              target[k] = newVal[k];
              merged = true;
            }
          }
          if (merged) {
            changed = true;
            if (target === oldVal) dropNestedWrapper(oldVal);
          }
          existingData[fieldKey] = merged ? target : oldVal;
        } else {
          // A key was added or removed. Replace wholesale, since copying field
          // by field can't apply a removal.
          existingData[fieldKey] = newVal;
          changed = true;
        }
      } else if (!sameValue(oldVal, newVal)) {
        // An equal value keeps the existing reference.
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
  // `Object.is`: re-applying NaN is not a change, and `-0` over `0` is one.
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (a instanceof FormattedValue || b instanceof FormattedValue) {
    return a instanceof FormattedValue && b instanceof FormattedValue && a._raw === b._raw;
  }
  // Distinct proxies are distinct entities. Other exotic objects (a Date, a
  // live collection binding, a class instance) fail the prototype check below.
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
    // `hasOwn`, not `in`: `in` would let `Object.prototype` answer for a key
    // missing from `b`.
    if (!Object.hasOwn(b, key)) return false;
    if (!sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/**
 * Compares the ref *key set*, which is what a write would change: the store
 * persists `refKeys` with no counts, and `setChildRefs` retains and releases on
 * a key appearing or disappearing. Comparing counts would force a write of
 * identical bytes.
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
  persist: PersistMode,
  childRefs: Map<EntityInstance, number>,
  appendMode: boolean,
  created: Set<EntityInstance> | undefined,
): void {
  for (const [fieldKey, propShape] of entries(shape)) {
    if (!(fieldKey in data)) continue;

    const raw = data[fieldKey];
    if (shouldReify(raw)) {
      // Assign only on change: an object the parser kept as is (from a fetch
      // result) may belong to the adapter and be frozen.
      const reified = reifyAndApply(raw, seen, queryClient, persist, childRefs, appendMode, created);
      if (reified !== raw) data[fieldKey] = reified;
    }

    if (propShape instanceof ValidatorDef && propShape._liveConfig !== undefined) {
      data[fieldKey] = createLiveCollection(
        propShape._liveConfig,
        data[fieldKey],
        entityInstance,
        entityData,
        queryClient,
        fieldKey,
      );
    } else {
      const val = data[fieldKey];
      if (isPlainObject(val)) {
        // Only object/entity defs have a record of field defs as their shape.
        // A record def's shape is its value type (a bare `Mask` for
        // `t.record(t.string)`), which must not be recursed into as fields.
        const nestedShape =
          propShape instanceof ValidatorDef &&
          propShape.shape !== undefined &&
          typeof propShape.shape === 'object' &&
          !(propShape.shape instanceof ValidatorDef) &&
          !(propShape.shape instanceof Set)
            ? (propShape.shape as Record<string, unknown>)
            : undefined;
        if (nestedShape !== undefined) {
          initFields(
            nestedShape,
            val,
            entityInstance,
            entityData,
            seen,
            queryClient,
            persist,
            childRefs,
            appendMode,
            created,
          );
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
