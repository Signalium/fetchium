import { relay, type ReactivePromise, type Notifier, notifier, reactiveMethod, setScopeOwner } from 'signalium';
import { registerCustomSnapshot } from 'signalium/utils';

type SnapshotFn = (current: unknown, prev: unknown) => unknown;
import { type EntityDef, Mask } from './types.js';
import { GcKeyType } from './GcManager.js';
import { Entity } from './proxy.js';
import { PROXY_ID } from './proxyId.js';
import type { QueryClient } from './QueryClient.js';
import { ValidatorDef, WRAPPED_VALUE } from './typeDefs.js';
import type { LiveCollectionBinding } from './LiveCollection.js';
import { entitySatisfiesShape } from './parseEntities.js';

// ======================================================
// Nested proxy wrapping — transparently unwraps WRAPPED_VALUE items
// (FormattedValue, LiveCollectionBinding) inside plain objects and arrays.
// ======================================================

const ObjectProto = Object.prototype;
const wrappingCache = new WeakMap<object, object>();

function wrapValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (WRAPPED_VALUE.has(value)) return wrapValue((value as { getValue(): unknown }).getValue());
  if (PROXY_ID.has(value as object)) return value;

  if (Array.isArray(value)) {
    let cached = wrappingCache.get(value);
    if (cached === undefined) {
      cached = new Proxy(value, arrayWrappingHandler);
      wrappingCache.set(value, cached);
    }
    return cached;
  }

  if (Object.getPrototypeOf(value) === ObjectProto) {
    let cached = wrappingCache.get(value);
    if (cached === undefined) {
      cached = new Proxy(value as Record<string, unknown>, objectWrappingHandler);
      wrappingCache.set(value, cached);
    }
    return cached;
  }

  return value;
}

const arrayWrappingHandler: ProxyHandler<unknown[]> = {
  get(target, prop, receiver) {
    if (typeof prop === 'string') {
      const idx = Number(prop);
      if (Number.isInteger(idx) && idx >= 0 && idx < target.length) {
        return wrapValue(target[idx]);
      }
    }
    return Reflect.get(target, prop, receiver);
  },
  set() {
    if (IS_DEV) throw new Error('Cannot mutate a read-only array');
    return false;
  },
  deleteProperty() {
    if (IS_DEV) throw new Error('Cannot mutate a read-only array');
    return false;
  },
};

const objectWrappingHandler: ProxyHandler<Record<string, unknown>> = {
  get(target, prop, receiver) {
    if (typeof prop === 'string') {
      return wrapValue(target[prop]);
    }
    return Reflect.get(target, prop, receiver);
  },
  set() {
    if (IS_DEV) throw new Error('Cannot mutate a read-only object');
    return false;
  },
  deleteProperty() {
    if (IS_DEV) throw new Error('Cannot mutate a read-only object');
    return false;
  },
  has(target, prop) {
    return prop in target;
  },
  ownKeys(target) {
    return Reflect.ownKeys(target);
  },
  getOwnPropertyDescriptor(target, prop) {
    return Object.getOwnPropertyDescriptor(target, prop);
  },
};

// ======================================================
// Custom snapshot for entity proxies — bridges Signalium v3's `useReactive`
// structural snapshot mechanism into our entity proxy graph.
//
// Without this, the snapshot encounters the entity proxy (whose prototype is
// the user-defined entity class), doesn't recognize it, and returns it as-is.
// React then never re-renders on data changes because the proxy reference is
// stable. Reading the entity's fields establishes reactive dependencies on the
// entity's notifier and produces a plain-object snapshot whose unchanged
// subtrees keep stable references. Fields come from each proxy's
// `EntitySnapshotSource`, not the proxy, which read every field twice.
// ======================================================

/** Trap-free access to one entity proxy's fields, registered by `createProxy`. */
interface EntitySnapshotSource {
  /** Identifies this proxy without retaining it. */
  readonly id: number;
  readonly instance: EntityInstance;
  readonly notifier: Notifier;
  readonly relay: ReactivePromise<Record<string, unknown>> | undefined;
  keys(): EntityKeys;
  /** `proxy[key]` before read-only wrapping. */
  readField(key: string): unknown;
}

const snapshotSources = new WeakMap<object, EntitySnapshotSource>();

let nextSnapshotSourceId = 1;

/**
 * What a snapshot was produced from, so the next one can skip work. Holds the
 * source's id, not the proxy: a snapshot outlives the entity it came from, and
 * a strong reference here would make the entity graph reachable from it.
 */
interface SnapshotOrigin {
  sourceId: number;
  version: number;
  keys: EntityKeys;
}

const snapshotOrigins = new WeakMap<object, SnapshotOrigin>();

function rememberSnapshot(
  sourceId: number,
  result: Record<string, unknown>,
  version: number,
  keys: EntityKeys,
): Record<string, unknown> {
  snapshotOrigins.set(result, { sourceId, version, keys });
  return result;
}

function indexSnapshotsBySource(prevArr: unknown[]): Map<number, unknown> {
  const index = new Map<number, unknown>();
  for (let i = 0; i < prevArr.length; i++) {
    const prevItem = prevArr[i];
    if (prevItem === null || typeof prevItem !== 'object') continue;
    const origin = snapshotOrigins.get(prevItem);
    if (origin !== undefined) index.set(origin.sourceId, prevItem);
  }
  return index;
}

function snapshotCameFrom(snapshotObj: unknown, sourceId: number): boolean {
  if (snapshotObj === null || typeof snapshotObj !== 'object') return false;
  return snapshotOrigins.get(snapshotObj)?.sourceId === sourceId;
}

function asPrevObject(prev: unknown): Record<string, unknown> | undefined {
  return prev !== null && typeof prev === 'object' && !Array.isArray(prev)
    ? (prev as Record<string, unknown>)
    : undefined;
}

/**
 * Snapshot a raw field value. Nested entity proxies go back to Signalium so
 * they consume their own notifier. The array and object walks mirror
 * `snapshotArray`/`snapshotPlainObject`, which `signalium/utils` does not
 * export; a test asserts they stay equal.
 */
function snapshotRawValue(value: unknown, prev: unknown, snap: SnapshotFn): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (WRAPPED_VALUE.has(value)) return snapshotRawValue((value as { getValue(): unknown }).getValue(), prev, snap);
  if (PROXY_ID.has(value)) return snap(value, prev);

  if (Array.isArray(value)) {
    const prevArr = Array.isArray(prev) ? prev : undefined;
    let changed = prevArr === undefined || prevArr.length !== value.length;
    let prevBySource: Map<number, unknown> | undefined;
    const result = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      let prevItem = prevArr !== undefined ? prevArr[i] : undefined;
      const itemSource = item !== null && typeof item === 'object' ? snapshotSources.get(item) : undefined;
      if (prevArr !== undefined && itemSource !== undefined) {
        if (prevBySource !== undefined) {
          prevItem = prevBySource.get(itemSource.id);
        } else if (i < prevArr.length && !snapshotCameFrom(prevItem, itemSource.id)) {
          // Positions shifted (an insert or re-sort), so pair by identity
          // rather than handing each entity its neighbour's snapshot. Indices
          // past the old length are appends and skip the index entirely.
          prevBySource = indexSnapshotsBySource(prevArr);
          prevItem = prevBySource.get(itemSource.id);
        }
      }
      const next = snapshotRawValue(item, prevItem, snap);
      result[i] = next;
      if (!changed && next !== prevArr![i]) changed = true;
    }
    return changed ? result : prevArr!;
  }

  if (Object.getPrototypeOf(value) === ObjectProto) {
    const obj = value as Record<string, unknown>;
    const prevObj = asPrevObject(prev);
    const keys = Object.keys(obj);
    let changed = prevObj === undefined || Object.keys(prevObj).length !== keys.length;
    const result: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const next = snapshotRawValue(obj[key], prevObj?.[key], snap);
      result[key] = next;
      if (!changed && next !== prevObj![key]) changed = true;
    }
    return changed ? result : prevObj!;
  }

  return snap(value, prev);
}

/** Dev-only counters: losing the fast path is invisible to behavioral tests. */
export let __debug_snapshotFieldReads = 0;
export let __debug_snapshotFullWalks = 0;
export function __debug_resetSnapshotCounters(): void {
  __debug_snapshotFieldReads = 0;
  __debug_snapshotFullWalks = 0;
}

function walkFields(
  source: EntitySnapshotSource,
  fields: string[],
  prevObj: Record<string, unknown> | undefined,
  snap: SnapshotFn,
  into: Record<string, unknown>,
): void {
  for (let i = 0; i < fields.length; i++) {
    const key = fields[i];
    const value = source.readField(key);
    if (IS_DEV) __debug_snapshotFieldReads++;
    // Methods are bound to the proxy and cached on it, so identity is stable.
    into[key] = typeof value === 'function' ? value : snapshotRawValue(value, prevObj?.[key], snap);
  }
}

const snapshotEntity = (current: object, prev: unknown, snap: SnapshotFn): unknown => {
  const source = snapshotSources.get(current);
  // An `Entity` that never went through `createProxy` has no fields to read —
  // its own properties are the shape's type defs. Hand it back untouched, the
  // way Signalium treats any class it has no handler for.
  if (source === undefined) return current;

  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  source.relay?.value;
  source.notifier.consume();

  const version = source.instance.version;
  const keys = source.keys();

  let prevObj = asPrevObject(prev);
  let origin = prevObj !== undefined ? snapshotOrigins.get(prevObj) : undefined;
  if (origin !== undefined && origin.sourceId !== source.id) {
    // Another entity's snapshot, from an array Signalium paired by position.
    prevObj = undefined;
    origin = undefined;
  }

  if (origin !== undefined && origin.version === version && origin.keys === keys) {
    // `data` is untouched, so only fields living elsewhere need re-reading.
    const before = prevObj!;
    const patch: Record<string, unknown> = {};
    walkFields(source, keys.dynamic, before, snap, patch);

    let result: Record<string, unknown> | undefined;
    for (let i = 0; i < keys.dynamic.length; i++) {
      const key = keys.dynamic[i];
      if (patch[key] !== before[key]) {
        if (result === undefined) result = { ...before };
        result[key] = patch[key];
      }
    }

    if (IS_DEV) assertStaticFieldsUnchanged(source, keys, before, snap);
    return rememberSnapshot(source.id, result ?? before, version, keys);
  }

  if (IS_DEV) __debug_snapshotFullWalks++;
  const enumerable = keys.enumerable;
  const result: Record<string, unknown> = {};
  walkFields(source, enumerable, prevObj, snap, result);

  let changed = prevObj === undefined || Object.keys(prevObj).length !== enumerable.length;
  if (!changed) {
    for (let i = 0; i < enumerable.length; i++) {
      if (result[enumerable[i]] !== prevObj![enumerable[i]]) {
        changed = true;
        break;
      }
    }
  }
  return rememberSnapshot(source.id, changed ? result : prevObj!, version, keys);
};

/**
 * Guards the fast path's assumptions: `data` only changes through a `notify()`
 * that bumps `version`, and every field outside `keys.dynamic` is a pure
 * function of `data`. Either breaking strands a snapshot permanently, which no
 * behavioral test catches. Skipped fields only — re-reading a dynamic field is
 * not identity-stable, since snapshotting a child updates state it pairs on.
 *
 * This costs dev builds the read the fast path saved, so the speedup shows up
 * in production builds only.
 */
function assertStaticFieldsUnchanged(
  source: EntitySnapshotSource,
  keys: EntityKeys,
  before: Record<string, unknown>,
  snap: SnapshotFn,
): void {
  const verified: Record<string, unknown> = {};
  const readsBefore = __debug_snapshotFieldReads;
  walkFields(source, keys.static, before, snap, verified);
  // This walk is verification, not work the fast path did.
  __debug_snapshotFieldReads = readsBefore;
  for (const key of keys.static) {
    if (verified[key] !== before[key]) {
      throw new Error(
        `[fetchium] stale entity snapshot: ${source.instance.typename}:${source.instance.id} field '${key}' ` +
          `changed while version stayed at ${source.instance.version}. Either the field was mutated without ` +
          `notify(), or the shape's static/dynamic split is wrong for it. This throws from inside a snapshot, ` +
          `so the reactive computation holding it stays in an error state and will rethrow on every read — ` +
          `reload rather than chasing the later throws, which are all this one.`,
      );
    }
  }
}

// Register once on the `Entity` base class. Signalium 3.0.1+ resolves custom
// snapshot handlers via prototype-chain lookup, so every user-defined entity
// subclass automatically inherits this handler — no per-class registration
// required.
registerCustomSnapshot(
  Entity as unknown as new (...args: unknown[]) => object,
  snapshotEntity as Parameters<typeof registerCustomSnapshot>[1],
);

// ======================================================

export class EntityInstance {
  private _notifier: Notifier;
  _queryClient: QueryClient;
  private _proxies = new Map<ValidatorDef<unknown>, Record<string, unknown>>();

  key: number;
  typename: string;
  id: string | number;
  idField: string | symbol;
  data: Record<string, unknown>;
  refCount: number = 0;
  entityRefs: Map<EntityInstance, number> | undefined;
  liveCollections: LiveCollectionBinding[] = [];
  satisfiedDefs: WeakSet<ValidatorDef<unknown>> = new WeakSet();
  parseId: number = -1;
  /** Bumped on `notify()`; see `assertStaticFieldsUnchanged` for the invariant. */
  version: number = 0;
  _entityCache: { gcTime?: number } | undefined;
  _extraMethods: Record<string, (...args: unknown[]) => unknown> | undefined;
  _extraGetters: Record<string, () => unknown> | undefined;

  constructor(
    key: number,
    typename: string,
    id: string | number,
    idField: string | symbol,
    data: Record<string, unknown>,
    queryClient: QueryClient,
  ) {
    this._notifier = notifier();
    this._queryClient = queryClient;
    this.key = key;
    this.typename = typename;
    this.id = id;
    this.idField = idField;
    this.data = data;
    this.entityRefs = undefined;
  }

  retain(): void {
    this.refCount++;
    const gcTime = this._entityCache?.gcTime;
    if (gcTime !== undefined) {
      this._queryClient.gcManager.cancel(this.key, gcTime);
    }
  }

  release(): void {
    if (--this.refCount > 0) return;
    if (this.refCount < 0) {
      if (IS_DEV) throw new Error(`Entity ${this.typename}:${this.id} released more times than retained`);
      return;
    }
    const gcTime = this._entityCache?.gcTime;
    if (gcTime !== undefined) {
      this._queryClient.gcManager.schedule(this.key, gcTime, GcKeyType.Entity);
    } else {
      this.evict();
    }
  }

  evict(): void {
    const bindings = this.liveCollections.slice();
    this.liveCollections.length = 0;
    for (const binding of bindings) binding.destroy();
    this._queryClient.entityMap.remove(this.key);
    const refs = this.entityRefs;
    this.entityRefs = undefined;
    if (refs) {
      for (const child of refs.keys()) child.release();
    }
  }

  setChildRefs(newRefs: Map<EntityInstance, number> | undefined, persist?: boolean): void {
    const oldRefs = this.entityRefs;
    if (newRefs !== undefined && newRefs.size > 0) {
      for (const child of newRefs.keys()) {
        if (oldRefs === undefined || !oldRefs.has(child)) child.retain();
      }
    }
    if (oldRefs !== undefined && oldRefs.size > 0) {
      for (const child of oldRefs.keys()) {
        if (newRefs === undefined || !newRefs.has(child)) child.release();
      }
    }
    this.entityRefs = newRefs;
    if (persist) this.save();
  }

  addChildRef(child: EntityInstance, persist: boolean = true): void {
    if (this.entityRefs === undefined) this.entityRefs = new Map();
    const count = this.entityRefs.get(child) ?? 0;
    this.entityRefs.set(child, count + 1);
    if (count === 0) child.retain();
    if (persist) this.save();
  }

  removeChildRef(child: EntityInstance, persist: boolean = true): void {
    if (this.entityRefs === undefined) return;
    const count = this.entityRefs.get(child);
    if (count === undefined) return;
    if (count <= 1) {
      this.entityRefs.delete(child);
      child.release();
    } else {
      this.entityRefs.set(child, count - 1);
    }
    if (persist) this.save();
  }

  getProxy(shape: EntityDef): Record<string, unknown> {
    const validatorDef = shape as unknown as ValidatorDef<unknown>;
    let proxy = this._proxies.get(validatorDef);
    if (proxy === undefined) {
      proxy = createProxy(this, this.key, shape, this._notifier, this._queryClient);
      this._proxies.set(validatorDef, proxy);
    }
    return proxy;
  }

  get proxy(): Record<string, unknown> | undefined {
    return this._proxies.values().next().value;
  }

  satisfiesDef(def: ValidatorDef<unknown>): boolean {
    if (this.satisfiedDefs.has(def)) return true;
    if (entitySatisfiesShape(this.data, def)) {
      this.satisfiedDefs.add(def);
      return true;
    }
    return false;
  }

  save(): void {
    this._queryClient.entityMap.save(this);
  }

  notify(): void {
    this.version++;
    this._notifier.notify();
  }

  consume(): void {
    this._notifier.consume();
  }
}

function filterEntityArray(array: unknown[], innerDef: ValidatorDef<unknown>, queryClient: QueryClient): unknown[] {
  const result: unknown[] = [];
  for (const item of array) {
    if (typeof item !== 'object' || item === null) continue;
    const entityKey = PROXY_ID.get(item);
    if (entityKey === undefined) continue;
    const entityInstance = queryClient.entityMap.getEntity(entityKey);
    if (entityInstance !== undefined && entityInstance.satisfiesDef(innerDef)) {
      result.push(item);
    }
  }
  return result;
}

// ======================================================
// Static-field analysis — which fields a version check covers
// ======================================================

/**
 * Masks for a field that can change without its owning entity notifying.
 *
 * No `UNION` bit, but not because the mask covers it: `defineUnion` ORs its
 * members' *top-level* masks, so `t.union(t.entity(A), …)` does carry `ENTITY`
 * while `t.union(t.object({ child: t.entity(A) }), …)` does not. What catches
 * the nested case is `computeIsStaticFieldDef` recursing into the union's
 * member defs. Short-circuiting a union on its mask alone would go stale.
 */
const DYNAMIC_MASKS = Mask.ENTITY | Mask.LIVE;

const staticFieldDefs = new WeakMap<ValidatorDef<unknown>, boolean>();

/**
 * Is a field's snapshot a pure function of its entity's own `data`? One-sided:
 * only the shapes recognised here answer `true`, mirroring the allowlist
 * `getEntityDef` validates against, so an unfamiliar def costs a read rather
 * than serving a stale value.
 */
function isStaticFieldDef(def: unknown): boolean {
  // `t.string` is a bare `Mask`, `t.typename('X')` the literal string,
  // `t.enum`/`t.const` a `Set` of allowed values.
  if (typeof def === 'number' || typeof def === 'string') return true;
  if (def instanceof Set) return true;
  if (!(def instanceof ValidatorDef)) return false;

  const cached = staticFieldDefs.get(def);
  if (cached !== undefined) return cached;
  // Break cycles as dynamic; a def only ever reached inside one keeps that
  // answer, which costs a read and never goes stale.
  staticFieldDefs.set(def, false);

  const isStatic = computeIsStaticFieldDef(def);
  staticFieldDefs.set(def, isStatic);
  return isStatic;
}

function computeIsStaticFieldDef(def: ValidatorDef<unknown>): boolean {
  if (def._liveConfig !== undefined) return false;
  if ((def.mask & DYNAMIC_MASKS) !== 0) return false;

  // No shape: primitive, format, or union of literals. One inner def: array,
  // record, parse result, optional/nullable clone. A record of defs: object.
  const shape = def.shape;
  if (shape === undefined || shape === null) return true;
  if (shape instanceof ValidatorDef) return isStaticFieldDef(shape);
  if (typeof shape !== 'object') return isStaticFieldDef(shape);
  if (shape instanceof Set) return true;
  return Object.values(shape as Record<string, unknown>).every(isStaticFieldDef);
}

// ======================================================
// Per-shape key metadata
// ======================================================

/**
 * The key lists a proxy reports, shared per shape. `own` is `ownKeys`;
 * `enumerable` drops the non-enumerable entity methods.
 */
interface EntityKeys {
  own: string[];
  enumerable: string[];
  dynamic: string[];
  /** `enumerable` minus `dynamic` — the fields a version check covers. */
  static: string[];
  enumerableSet: Set<string>;
}

const shapeKeyCache = new WeakMap<ValidatorDef<unknown>, EntityKeys>();

function shapeKeys(
  validatorDef: ValidatorDef<unknown>,
  shapeFields: Record<string, unknown>,
  methods: Record<string, (...args: unknown[]) => unknown> | undefined,
): EntityKeys {
  let keys = shapeKeyCache.get(validatorDef);
  if (keys !== undefined) return keys;

  const own = Object.keys(shapeFields);
  if (!own.includes('__typename')) own.push('__typename');
  const enumerable = own.slice();
  if (methods !== undefined) {
    for (const methodKey of Object.keys(methods)) {
      if (!own.includes(methodKey)) own.push(methodKey);
    }
  }
  const dynamic = enumerable.filter(key => key !== '__typename' && !isStaticFieldDef(shapeFields[key]));

  const dynamicSet = new Set(dynamic);
  keys = {
    own,
    enumerable,
    dynamic,
    static: enumerable.filter(key => !dynamicSet.has(key)),
    enumerableSet: new Set(enumerable),
  };
  shapeKeyCache.set(validatorDef, keys);
  return keys;
}

/** Plus a query's late-attached methods and getters, always dynamic. */
function withExtraKeys(
  base: EntityKeys,
  extraMethods: Record<string, unknown> | undefined,
  extraGetters: Record<string, unknown> | undefined,
): EntityKeys {
  const own = base.own.slice();
  const enumerable = base.enumerable.slice();
  const dynamic = base.dynamic.slice();
  for (const extras of [extraMethods, extraGetters]) {
    if (extras === undefined) continue;
    for (const key of Object.keys(extras)) {
      if (!own.includes(key)) own.push(key);
      if (!enumerable.includes(key)) enumerable.push(key);
      if (!dynamic.includes(key)) dynamic.push(key);
    }
  }
  const dynamicSet = new Set(dynamic);
  return {
    own,
    enumerable,
    dynamic,
    static: enumerable.filter(key => !dynamicSet.has(key)),
    enumerableSet: new Set(enumerable),
  };
}

// ======================================================
// Field readers — module level so each proxy holds a pointer, not a closure
// ======================================================

function bindMethod(
  prop: string,
  source: Record<string, (...args: unknown[]) => unknown>,
  cache: Map<string, (...args: unknown[]) => unknown>,
  proxy: object,
  reactive: boolean,
): (...args: unknown[]) => unknown {
  let bound = cache.get(prop);
  if (bound === undefined) {
    bound = source[prop].bind(proxy);
    if (reactive) bound = reactiveMethod(proxy, bound);
    cache.set(prop, bound);
  }
  return bound;
}

/** Narrow a shared-typename array to this field's def, cached on array identity. */
function narrowEntityArray(
  prop: string,
  value: unknown[],
  shapeFields: Record<string, unknown>,
  filterCache: Map<string, { source: unknown[]; filtered: unknown[] }>,
  queryClient: QueryClient,
): unknown[] {
  const fieldDef = shapeFields[prop];
  if (fieldDef instanceof ValidatorDef && (fieldDef.mask & Mask.ARRAY) !== 0) {
    const innerDef = fieldDef.shape as ValidatorDef<unknown> | undefined;
    if (innerDef instanceof ValidatorDef && (innerDef.mask & Mask.ENTITY) !== 0) {
      const typename = innerDef.typenameValue;
      if (typename !== undefined) {
        const defs = queryClient.getEntityDefsForTypename(typename);
        if (defs !== undefined && defs.length > 1) {
          const cached = filterCache.get(prop);
          if (cached !== undefined && cached.source === value) {
            return cached.filtered;
          }
          const filtered = filterEntityArray(value, innerDef, queryClient);
          filterCache.set(prop, { source: value, filtered });
          return filtered;
        }
      }
    }
  }
  return value;
}

// ======================================================
// Proxy Creation (module-level function, not a method)
// ======================================================

function createProxy(
  instance: EntityInstance,
  key: number,
  shape: EntityDef,
  entityNotifier: Notifier,
  queryClient: QueryClient,
): Record<string, unknown> {
  const shapeFields = shape.shape ?? {};
  const validatorDef = shape as unknown as ValidatorDef<unknown>;
  const methods = validatorDef._methods;
  const entityClass = validatorDef._entityClass;
  const entityConfig = validatorDef._entityConfig;
  const proto = entityClass ? entityClass.prototype : Entity.prototype;
  const typenameField = shape.typenameField;

  const wrappedMethods = new Map<string, (...args: unknown[]) => unknown>();
  const filterCache = new Map<string, { source: unknown[]; filtered: unknown[] }>();

  const toJSON = () => ({ __entityRef: key });

  let entityRelay: ReactivePromise<Record<string, unknown>> | undefined;

  if (entityConfig?.hasSubscribe && methods && '__subscribe' in methods) {
    entityRelay = relay(state => {
      const onEvent = (event: import('./types.js').MutationEvent) => {
        event.__eventSource = key;
        queryClient.applyMutationEvent(event);
      };

      const unsubscribe = methods['__subscribe'].call(proxy, onEvent);
      state.value = proxy;

      return unsubscribe;
    });
  }

  let proxy: Record<string, unknown>;

  if (IS_DEV && typenameField && !(typenameField in shapeFields)) {
    throw new Error(`typenameField "${typenameField}" must be declared in the entity shape`);
  }

  // Shared per shape; only a query's root entity allocates its own lists.
  const baseKeys = shapeKeys(validatorDef, shapeFields, methods);
  let cachedMethods: Record<string, unknown> | undefined;
  let cachedGetters: Record<string, unknown> | undefined;
  let keys = baseKeys;

  function entityKeys(): EntityKeys {
    // Both slots: these lists decide what a snapshot walks and re-reads.
    const methodsNow = instance._extraMethods;
    const gettersNow = instance._extraGetters;
    if (methodsNow !== cachedMethods || gettersNow !== cachedGetters) {
      cachedMethods = methodsNow;
      cachedGetters = gettersNow;
      keys =
        methodsNow === undefined && gettersNow === undefined
          ? baseKeys
          : withExtraKeys(baseKeys, methodsNow, gettersNow);
    }
    return keys;
  }

  // The `get` trap's value half, minus reactive bookkeeping and wrapping.
  // Symbols, `toJSON` and `__context` never reach here.
  function readField(prop: string): unknown {
    if (prop === '__typename') return instance.typename;

    const extraGetters = instance._extraGetters;
    if (extraGetters !== undefined && prop in extraGetters) return extraGetters[prop]();

    const extraMethods = instance._extraMethods;
    if (extraMethods !== undefined && prop in extraMethods) {
      return bindMethod(prop, extraMethods, wrappedMethods, proxy, false);
    }

    if (methods !== undefined && prop in methods) {
      return bindMethod(prop, methods, wrappedMethods, proxy, true);
    }

    const value = instance.data[prop];
    return Array.isArray(value) ? narrowEntityArray(prop, value, shapeFields, filterCache, queryClient) : value;
  }

  const handler: ProxyHandler<object> = {
    getPrototypeOf() {
      return proto;
    },

    get(target, prop, receiver) {
      // Symbol-keyed gets resolve against the virtual prototype (the entity
      // class). This keeps the trap fast — entity prototypes don't define
      // most well-known symbols (Symbol.iterator, etc.), so the lookup
      // returns undefined immediately — and crucially lets external libraries
      // (e.g. Signalium's `registerCustomSnapshot`, which stores its handler
      // as a private symbol on the prototype) resolve their symbol keys via
      // the standard prototype chain. Without this, Signalium can't find the
      // entity snapshot handler through the proxy and entity updates won't
      // re-render across the React boundary.
      if (typeof prop === 'symbol') return Reflect.get(proto, prop, receiver);
      if (prop === 'toJSON') return toJSON;
      if (prop === '__context') return queryClient.getContext();
      if (prop === '__typename') return instance.typename;

      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      entityRelay?.value;

      entityNotifier.consume();

      return wrapValue(readField(prop));
    },

    set() {
      if (IS_DEV) throw new Error('Entity properties are read-only');
      return false;
    },

    has(target, prop) {
      if (prop === '__typename') return true;
      if (typeof prop === 'string') {
        const extraGetters = instance._extraGetters;
        if (extraGetters && prop in extraGetters) return true;
        const extraMethods = instance._extraMethods;
        if (extraMethods && prop in extraMethods) return true;
        if (methods && prop in methods) return true;
      }
      return prop in shapeFields;
    },

    ownKeys() {
      return entityKeys().own;
    },

    getOwnPropertyDescriptor(target, prop) {
      // Same list the snapshot walks, so the two agree by construction.
      if (typeof prop !== 'string') return undefined;
      if (entityKeys().enumerableSet.has(prop)) {
        return { enumerable: true, configurable: true, value: handler.get!(target, prop, proxy), writable: false };
      }
      if (methods !== undefined && prop in methods) {
        return { enumerable: false, configurable: true, value: handler.get!(target, prop, proxy), writable: false };
      }
      return undefined;
    },
  };

  proxy = new Proxy<Record<string, unknown>>({} as Record<string, unknown>, handler);

  PROXY_ID.set(proxy, key);
  snapshotSources.set(proxy, {
    id: nextSnapshotSourceId++,
    instance,
    notifier: entityNotifier,
    relay: entityRelay,
    keys: entityKeys,
    readField,
  });
  setScopeOwner(proxy, queryClient);

  return proxy;
}
