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
// stable. Reading the fields consumes the entity's notifier and yields a plain
// snapshot whose unchanged subtrees keep stable references.
// ======================================================

/** Trap-free access to one entity proxy's fields. */
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

/** Holds the source id, not the proxy, so a snapshot never retains the entity graph. */
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

/** Dev-only: a consumer that mutates a snapshot throws at its call site. */
function freezeInDev<T extends object>(obj: T): T {
  return IS_DEV ? Object.freeze(obj) : obj;
}

function asPrevObject(prev: unknown): Record<string, unknown> | undefined {
  return prev !== null && typeof prev === 'object' && !Array.isArray(prev)
    ? (prev as Record<string, unknown>)
    : undefined;
}

/** Mirrors Signalium's unexported array and object walks. A test asserts they match. */
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
          // Positions shifted, so pair by identity rather than by index.
          prevBySource = indexSnapshotsBySource(prevArr);
          prevItem = prevBySource.get(itemSource.id);
        }
      }
      const next = snapshotRawValue(item, prevItem, snap);
      result[i] = next;
      // `Object.is`, so a NaN slot doesn't change identity on every walk.
      if (!changed && !Object.is(next, prevArr![i])) changed = true;
    }
    return changed ? freezeInDev(result) : prevArr!;
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
      if (!changed && !Object.is(next, prevObj![key])) changed = true;
    }
    return changed ? freezeInDev(result) : prevObj!;
  }

  return snap(value, prev);
}

/** Dev guard: tells real drift from a value that only lost identity, like a rebuilt `Set`. */
function sameSnapshotValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameSnapshotValue(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
    // Pair by position, searching only after the first misalignment.
    const bItems = [...b];
    let matched: Set<number> | undefined;
    let i = 0;
    for (const item of a) {
      if (matched === undefined && sameSnapshotValue(item, bItems[i])) {
        i++;
        continue;
      }
      if (matched === undefined) {
        matched = new Set();
        for (let k = 0; k < i; k++) matched.add(k);
      }
      const j = bItems.findIndex((other, idx) => !matched!.has(idx) && sameSnapshotValue(item, other));
      if (j === -1) return false;
      matched.add(j);
      i++;
    }
    return true;
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !sameSnapshotValue(v, b.get(k))) return false;
    return true;
  }
  if (Object.getPrototypeOf(a) !== ObjectProto || Object.getPrototypeOf(b) !== ObjectProto) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key)) return false;
    if (!sameSnapshotValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
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
    // Bound methods are cached, so their identity is stable.
    into[key] = typeof value === 'function' ? value : snapshotRawValue(value, prevObj?.[key], snap);
  }
}

/** For proxies from a previous instance of this module (hot reload), absent from `snapshotSources`. */
function snapshotProxyByWalking(current: object, prev: unknown, snap: SnapshotFn): unknown {
  const obj = current as Record<string, unknown>;
  const keys = Object.keys(obj);
  const prevObj = asPrevObject(prev);
  let changed = prevObj === undefined || Object.keys(prevObj).length !== keys.length;
  const result: Record<string, unknown> = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const val = obj[key];
    const next = typeof val === 'function' ? val : snap(val, prevObj?.[key]);
    result[key] = next;
    if (!changed && !Object.is(next, prevObj![key])) changed = true;
  }
  return changed ? freezeInDev(result) : prevObj;
}

const snapshotEntity = (current: object, prev: unknown, snap: SnapshotFn): unknown => {
  const source = snapshotSources.get(current);
  if (source === undefined) {
    // Hot-reloaded proxy. Returning it as-is would stop React re-rendering on its changes.
    if (PROXY_ID.has(current) || typeof (current as { toJSON?: unknown }).toJSON === 'function') {
      return snapshotProxyByWalking(current, prev, snap);
    }
    // A bare `Entity` has no fields to read, only the shape's type defs.
    return current;
  }

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
    // `data` is untouched, so only dynamic fields need re-reading.
    const before = prevObj!;
    const patch: Record<string, unknown> = {};
    walkFields(source, keys.dynamic, before, snap, patch);

    let result: Record<string, unknown> | undefined;
    for (let i = 0; i < keys.dynamic.length; i++) {
      const key = keys.dynamic[i];
      if (!Object.is(patch[key], before[key])) {
        if (result === undefined) result = { ...before };
        result[key] = patch[key];
      }
    }

    if (IS_DEV) {
      // Report drift, don't throw: Signalium's watcher flush has no catch.
      const drifted = verifyStaticFields(source, keys, before, snap);
      if (drifted !== undefined) {
        if (result === undefined) result = { ...before };
        for (const key of Object.keys(drifted)) result[key] = drifted[key];
      }
      // A consumer altered the snapshot's keys. Frozen ones can't have been.
      if (!Object.isFrozen(before) && !sameKeyList(Object.keys(before), keys.enumerable)) {
        const source_ = result ?? before;
        const rebuilt: Record<string, unknown> = {};
        for (const key of keys.enumerable) rebuilt[key] = source_[key];
        result = rebuilt;
        reportDrift(source, '(keys)', 'its key set was altered');
      }
    }
    return rememberSnapshot(source.id, result !== undefined ? freezeInDev(result) : before, version, keys);
  }

  if (IS_DEV) __debug_snapshotFullWalks++;
  const enumerable = keys.enumerable;
  const result: Record<string, unknown> = {};
  walkFields(source, enumerable, prevObj, snap, result);

  let changed = prevObj === undefined || Object.keys(prevObj).length !== enumerable.length;
  if (!changed) {
    for (let i = 0; i < enumerable.length; i++) {
      if (!Object.is(result[enumerable[i]], prevObj![enumerable[i]])) {
        changed = true;
        break;
      }
    }
  }
  return rememberSnapshot(source.id, changed ? freezeInDev(result) : prevObj!, version, keys);
};

function sameKeyList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Dev-only: drifts already raised, keyed `typename.field`. */
const reportedDrift = new Set<string>();

export type SnapshotDriftHandler = (error: Error, queryClient: QueryClient) => void;

/** Rethrows in a microtask so the error surfaces as uncaught, outside Signalium's watcher flush. */
const defaultDriftHandler: SnapshotDriftHandler = (error, queryClient) => {
  queryClient.getContext().log?.error?.(error.message, error);
  queueMicrotask(() => {
    throw error;
  });
};

let snapshotDriftHandler: SnapshotDriftHandler = defaultDriftHandler;

/** Dev-only test hook. Also clears the raised set. `undefined` restores the default. */
export function __setSnapshotDriftHandler(handler: SnapshotDriftHandler | undefined): void {
  snapshotDriftHandler = handler ?? defaultDriftHandler;
  reportedDrift.clear();
}

function reportDrift(source: EntitySnapshotSource, key: string, what: string): void {
  const tag = `${source.instance.typename}.${key}`;
  if (reportedDrift.has(tag)) return;
  reportedDrift.add(tag);
  const error = new Error(
    `[fetchium] stale entity snapshot: ${source.instance.typename}:${source.instance.id} ${what} while version ` +
      `stayed at ${source.instance.version}. The re-read value is being served, but a production build would keep ` +
      `the stale one. Either the field was mutated without notify(), the shape's static/dynamic split is wrong ` +
      `for it, or a consumer mutated a snapshot it received (dev snapshots are frozen so that fails at the call ` +
      `site; in production they are not). Raised once per field.`,
  );
  snapshotDriftHandler(error, source.instance._queryClient);
}

/**
 * Checks the fast path's assumptions: `data` only changes through a `notify()`
 * that bumps `version`, and every field outside `keys.dynamic` is a pure
 * function of `data`. Returns the static fields that drifted, if any.
 * Dynamic fields are skipped, since re-reading them is not identity-stable.
 *
 * The re-read cancels the fast path's savings, so the speedup only shows in
 * production builds.
 */
function verifyStaticFields(
  source: EntitySnapshotSource,
  keys: EntityKeys,
  before: Record<string, unknown>,
  snap: SnapshotFn,
): Record<string, unknown> | undefined {
  const verified: Record<string, unknown> = {};
  const readsBefore = __debug_snapshotFieldReads;
  walkFields(source, keys.static, before, snap, verified);
  __debug_snapshotFieldReads = readsBefore;
  let drifted: Record<string, unknown> | undefined;
  for (const key of keys.static) {
    if (Object.is(verified[key], before[key]) || sameSnapshotValue(verified[key], before[key])) continue;
    if (drifted === undefined) drifted = {};
    drifted[key] = verified[key];
    reportDrift(source, key, `field '${key}' changed`);
  }
  return drifted;
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
  _persisted: boolean = false;
  /** Writes sent to an acknowledging store, not yet acknowledged. */
  _pendingWrites: number = 0;
  /** An apply is still reifying this instance's fields. */
  _applying: boolean = false;
  /** Data came only from events, so a write merges over the stored record. */
  _partial: boolean = false;
  /** With `_partial`: the fields a write merges. */
  _partialKeys: Set<string> | undefined = undefined;
  /** A write waiting for a child's apply to finish. */
  _deferredWrite: boolean = false;
  /** The store is known to hold a record of this entity. */
  _recorded: boolean = false;
  private _saving: boolean = false;
  entityRefs: Map<EntityInstance, number> | undefined;
  liveCollections: LiveCollectionBinding[] = [];
  satisfiedDefs: WeakSet<ValidatorDef<unknown>> = new WeakSet();
  parseId: number = -1;
  /** Snapshots trust this to move whenever `data` changes. */
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
        if (newRefs === undefined || !newRefs.has(child)) {
          child.release();
          if (persist) this.writeDropsRef(child);
        }
      }
    }
    this.entityRefs = newRefs;
    if (persist) this.save();
  }

  /**
   * The write may delete the child's record after the current apply, so it is
   * rewritten rather than trusted. Sync stores report deletes via `onDelete`.
   */
  private writeDropsRef(child: EntityInstance): void {
    if (this._queryClient.storeAcksWrites) child.recordDropped();
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
      if (persist) this.writeDropsRef(child);
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

  /** `storeHolds`: the store's `hasEntity` answer, if the caller already has it. */
  save(storeHolds?: boolean): void {
    const client = this._queryClient;
    if (this._saving) return;
    this._saving = true;
    try {
      // References must point at existing records, so unrecorded children are
      // written first. A child still being reified defers both writes.
      const refs = this.entityRefs;
      if (refs !== undefined) {
        let deferred = false;
        for (const child of refs.keys()) {
          if (child._recorded || child._persisted || child._pendingWrites > 0 || child._saving) continue;
          if (client.entityMap.getEntity(child.key) !== child) continue;
          if (child._applying) {
            client.deferWrite(child);
            deferred = true;
          } else {
            try {
              child.save();
            } catch (e) {
              this.markUnwritten();
              throw e;
            }
            if (child._deferredWrite) deferred = true;
          }
        }
        if (deferred) {
          this._deferredWrite = true;
          client.deferWrite(this);
          return;
        }
      }
      this._deferredWrite = false;
      // No record to merge over, so the fields held are the whole record.
      if (this._partial && !this._recorded && (storeHolds ?? client.store.hasEntity?.(this.key)) === false) {
        this._partial = false;
        this._partialKeys = undefined;
      }
      // Counted before the call: a store may acknowledge synchronously.
      if (client.storeAcksWrites) this._pendingWrites++;
      try {
        client.entityMap.save(this, this._partial ? this._partialKeys : undefined);
      } catch (e) {
        this.markUnwritten();
        throw e;
      }
      // After the call, so a throwing store leaves it unset.
      if (!client.storeAcksWrites) this._persisted = this._recorded = true;
    } finally {
      this._saving = false;
    }
  }

  /** A live field of this entity gained or lost a member outside an apply. */
  liveFieldChanged(fieldKey: string): void {
    if (this._partial) this._partialKeys?.add(fieldKey);
  }

  /** Ignores acks for writes a previous instance of this entity dispatched. */
  acknowledgeWrite(): void {
    if (this._pendingWrites === 0) return;
    if (--this._pendingWrites === 0) this._persisted = this._recorded = true;
  }

  /** The store dropped (or failed to write) this entity's record. */
  recordDropped(): void {
    this._recorded = false;
    this.markUnwritten();
  }

  /** Forces the next apply to write. Queued writes hold older data, so their acks are dropped. */
  markUnwritten(): void {
    this._persisted = false;
    this._pendingWrites = 0;
  }

  notify(): void {
    this.version++;
    this._notifier.notify();
  }

  consume(): void {
    this._notifier.consume();
  }
}

function sameMembers(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface NarrowedArray {
  source: unknown[];
  filtered: unknown[];
  /** Members not (yet) satisfying the def, the only ones whose membership can change. */
  excluded: EntityInstance[];
  parseId: number;
}

function filterEntityArray(
  array: unknown[],
  innerDef: ValidatorDef<unknown>,
  queryClient: QueryClient,
): { filtered: unknown[]; excluded: EntityInstance[] } {
  const filtered: unknown[] = [];
  const excluded: EntityInstance[] = [];
  for (const item of array) {
    if (typeof item !== 'object' || item === null) continue;
    const entityKey = PROXY_ID.get(item);
    if (entityKey === undefined) continue;
    const entityInstance = queryClient.entityMap.getEntity(entityKey);
    if (entityInstance === undefined) continue;
    if (entityInstance.satisfiesDef(innerDef)) filtered.push(item);
    else excluded.push(entityInstance);
  }
  return { filtered, excluded };
}

// Fields that can change without the entity notifying (formats may read other signals).
// A union's mask omits its members' nested bits, so never trust a union's mask alone.
const DYNAMIC_MASKS = Mask.ENTITY | Mask.LIVE | Mask.HAS_FORMAT;

const staticFieldDefs = new WeakMap<ValidatorDef<unknown>, boolean>();

/** Unrecognised defs answer false, which costs a re-read but never a stale value. */
function isStaticFieldDef(def: unknown): boolean {
  if (typeof def === 'number') return (def & DYNAMIC_MASKS) === 0;
  if (typeof def === 'string') return true;
  if (def instanceof Set) return true;
  if (!(def instanceof ValidatorDef)) return false;

  const cached = staticFieldDefs.get(def);
  if (cached !== undefined) return cached;
  // Cycles resolve as dynamic.
  staticFieldDefs.set(def, false);

  const isStatic = computeIsStaticFieldDef(def);
  staticFieldDefs.set(def, isStatic);
  return isStatic;
}

function computeIsStaticFieldDef(def: ValidatorDef<unknown>): boolean {
  if (def._liveConfig !== undefined) return false;
  if ((def.mask & DYNAMIC_MASKS) !== 0) return false;

  const shape = def.shape;
  if (shape === undefined || shape === null) return true;
  if (shape instanceof ValidatorDef) return isStaticFieldDef(shape);
  if (typeof shape !== 'object') return isStaticFieldDef(shape);
  if (shape instanceof Set) return true;
  // Reflect.ownKeys: a union's array/record members sit under symbol keys.
  const fields = shape as Record<string | symbol, unknown>;
  const keys = Reflect.ownKeys(fields);
  for (let i = 0; i < keys.length; i++) {
    if (!isStaticFieldDef(fields[keys[i]])) return false;
  }
  return true;
}

// ======================================================
// Per-shape key metadata
// ======================================================

/**
 * The key lists a proxy reports, shared per shape. `own` is `ownKeys`;
 * `enumerable` drops the non-enumerable entity methods.
 */
export interface EntityKeys {
  own: string[];
  enumerable: string[];
  dynamic: string[];
  static: string[];
  enumerableSet: Set<string>;
}

/** No class sharing the typename can put an entity under a shapeless field. */
function isShapelessFieldDef(def: unknown): boolean {
  if (typeof def === 'number' || typeof def === 'string') return true;
  if (def instanceof Set) return true;
  return def instanceof ValidatorDef && (def.shape === undefined || def.shape === null);
}

/** Cached per client: the split depends on which classes share the typename. */
function shapeKeys(
  validatorDef: ValidatorDef<unknown>,
  shapeFields: Record<string, unknown>,
  methods: Record<string, (...args: unknown[]) => unknown> | undefined,
  queryClient: QueryClient,
): EntityKeys {
  const cache = queryClient.shapeKeyCache;
  let keys = cache.get(validatorDef);
  if (keys !== undefined) return keys;

  const own = Object.keys(shapeFields);
  if (!own.includes('__typename')) own.push('__typename');
  const enumerable = own.slice();
  if (methods !== undefined) {
    for (const methodKey of Object.keys(methods)) {
      if (!own.includes(methodKey)) own.push(methodKey);
    }
  }
  // Another class sharing the typename may write an entity into a nested object.
  const typename = validatorDef.typenameValue;
  const shared = typename !== undefined && (queryClient.getEntityDefsForTypename(typename)?.length ?? 0) > 1;
  const dynamic = enumerable.filter(
    key =>
      key !== '__typename' &&
      (!isStaticFieldDef(shapeFields[key]) || (shared && !isShapelessFieldDef(shapeFields[key]))),
  );

  const dynamicSet = new Set(dynamic);
  keys = {
    own,
    enumerable,
    dynamic,
    static: enumerable.filter(key => !dynamicSet.has(key)),
    enumerableSet: new Set(enumerable),
  };
  cache.set(validatorDef, keys);
  return keys;
}

/** A query's late-attached methods and getters are always dynamic. */
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

/** An excluded member that gains the def's fields must recompute the consumer. */
function consumeExcluded(excluded: EntityInstance[]): void {
  for (let i = 0; i < excluded.length; i++) excluded[i].consume();
}

/** Narrow a shared-typename array to this field's def, cached on array identity. */
function narrowEntityArray(
  prop: string,
  value: unknown[],
  shapeFields: Record<string, unknown>,
  filterCache: Map<string, NarrowedArray>,
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
          // Keyed on the apply epoch too: a member can gain the def's fields without the array changing.
          const parseId = queryClient.currentParseId;
          const cached = filterCache.get(prop);
          if (cached !== undefined && cached.source === value && cached.parseId === parseId) {
            consumeExcluded(cached.excluded);
            return cached.filtered;
          }
          const narrowed = filterEntityArray(value, innerDef, queryClient);
          let filtered = narrowed.filtered;
          if (cached !== undefined && sameMembers(cached.filtered, filtered)) filtered = cached.filtered;
          filterCache.set(prop, { source: value, filtered, excluded: narrowed.excluded, parseId });
          consumeExcluded(narrowed.excluded);
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
  const filterCache = new Map<string, NarrowedArray>();

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
  let cachedBaseCache: QueryClient['shapeKeyCache'] | undefined;
  let cachedMethods: Record<string, unknown> | undefined;
  let cachedGetters: Record<string, unknown> | undefined;
  let keys: EntityKeys | undefined;

  function entityKeys(): EntityKeys {
    // The client replaces its key cache when a class registers for this typename.
    const baseCache = queryClient.shapeKeyCache;
    const methodsNow = instance._extraMethods;
    const gettersNow = instance._extraGetters;
    if (
      keys === undefined ||
      baseCache !== cachedBaseCache ||
      methodsNow !== cachedMethods ||
      gettersNow !== cachedGetters
    ) {
      const base = shapeKeys(validatorDef, shapeFields, methods, queryClient);
      cachedBaseCache = baseCache;
      cachedMethods = methodsNow;
      cachedGetters = gettersNow;
      keys = methodsNow === undefined && gettersNow === undefined ? base : withExtraKeys(base, methodsNow, gettersNow);
    }
    return keys;
  }

  // The `get` trap's value path, without tracking or wrapping.
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
      // Same list the snapshot walks.
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
