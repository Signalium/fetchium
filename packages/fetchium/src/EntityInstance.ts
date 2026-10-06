import { relay, type ReactivePromise, type Notifier, notifier, reactiveMethod, setScopeOwner } from 'signalium';
import { registerCustomSnapshot } from 'signalium/utils';

type SnapshotFn = (current: unknown, prev: unknown) => unknown;
import { type EntityDef, Mask } from './types.js';
import { GcKeyType } from './GcManager.js';
import { Entity } from './proxy.js';
import { PROXY_ID } from './proxyId.js';
import { NESTED_WRAPPERS } from './nestedNotifiers.js';
import type { QueryClient } from './QueryClient.js';
import { ValidatorDef, WRAPPED_VALUE } from './typeDefs.js';
import type { LiveCollectionBinding } from './LiveCollection.js';
import { entitySatisfiesShape } from './parseEntities.js';
import { recordRestOutside } from './stores/shared.js';

/**
 * Fields of an entity's stored record that no class applied to the in-memory
 * instance declares: another class sharing the typename wrote them, in this
 * session or an earlier one. Kept, as raw record JSON, so the instance's
 * writes carry them instead of dropping them from the record.
 */
export interface RecordRest {
  /** The fields kept. */
  keys: string[];
  /** Their raw values as a JSON object body (`"a":1,"b":{…}`), written as is. */
  json: string;
  /** The `{ __entityRef }` keys inside them, which the record goes on referencing. */
  refIds: number[];
}

// ======================================================
// Nested proxy wrapping — transparently unwraps WRAPPED_VALUE items
// (FormattedValue, LiveCollectionBinding) inside plain objects and arrays.
// ======================================================

const ObjectProto = Object.prototype;
// A module-local binding: read on every nested read.
const nestedWrappers = NESTED_WRAPPERS;

/** A `WRAPPED_VALUE` item. A live collection's value changes under its own notifier. */
interface WrappedValue {
  getValue(): unknown;
  readonly _valueOwner?: Notifier;
}

/**
 * `owner` is the notifier of a live collection whose value this is (or is
 * inside): a reducer or an event can change such a value in place, so reads
 * through its wrapper consume that notifier. Without one, the value is an
 * entity's nested object, record or array. Its wrapper consumes nothing: a
 * merge that changes it in place drops the wrapper (`dropNestedWrapper`), so
 * the next read through the entity, which the entity's notifier re-runs,
 * hands out a new one. Whoever was given only the nested value (a child
 * component given `entity.price` as a prop) then sees a new value too.
 */
function wrapValue(value: unknown, owner: Notifier | undefined): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (WRAPPED_VALUE.has(value)) {
    const wrapped = value as WrappedValue;
    return wrapValue(wrapped.getValue(), wrapped._valueOwner ?? owner);
  }
  if (PROXY_ID.has(value as object)) return value;

  if (Array.isArray(value)) {
    let wrapper = nestedWrappers.get(value);
    if (wrapper === undefined) {
      wrapper = new Proxy(value, owner === undefined ? arrayWrappingHandler : new OwnedArrayHandler(owner));
      nestedWrappers.set(value, wrapper);
    }
    return wrapper;
  }

  if (Object.getPrototypeOf(value) === ObjectProto) {
    let wrapper = nestedWrappers.get(value);
    if (wrapper === undefined) {
      wrapper = new Proxy(
        value as Record<string, unknown>,
        owner === undefined ? objectWrappingHandler : new OwnedObjectHandler(owner),
      );
      nestedWrappers.set(value, wrapper);
    }
    return wrapper;
  }

  return value;
}

const arrayWrappingHandler: ProxyHandler<unknown[]> = {
  get(target, prop, receiver) {
    if (typeof prop === 'string') {
      const idx = Number(prop);
      if (Number.isInteger(idx) && idx >= 0 && idx < target.length) {
        return wrapValue(target[idx], undefined);
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
      return wrapValue(target[prop], undefined);
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

/**
 * The wrapper of a value inside a live collection: its traps consume the
 * collection's notifier, and values read through it inherit that owner.
 */
class OwnedArrayHandler implements ProxyHandler<unknown[]> {
  constructor(readonly owner: Notifier) {}

  get(target: unknown[], prop: string | symbol, receiver: unknown): unknown {
    // Every read, `length` and the iteration methods included: an in-place
    // push changes what all of them return.
    this.owner.consume();
    if (typeof prop === 'string') {
      const idx = Number(prop);
      if (Number.isInteger(idx) && idx >= 0 && idx < target.length) {
        return wrapValue(target[idx], this.owner);
      }
    }
    return Reflect.get(target, prop, receiver);
  }

  set(): boolean {
    if (IS_DEV) throw new Error('Cannot mutate a read-only array');
    return false;
  }

  deleteProperty(): boolean {
    if (IS_DEV) throw new Error('Cannot mutate a read-only array');
    return false;
  }
}

class OwnedObjectHandler implements ProxyHandler<Record<string, unknown>> {
  constructor(readonly owner: Notifier) {}

  get(target: Record<string, unknown>, prop: string | symbol, receiver: unknown): unknown {
    if (typeof prop === 'string') {
      this.owner.consume();
      return wrapValue(target[prop], this.owner);
    }
    return Reflect.get(target, prop, receiver);
  }

  set(): boolean {
    if (IS_DEV) throw new Error('Cannot mutate a read-only object');
    return false;
  }

  deleteProperty(): boolean {
    if (IS_DEV) throw new Error('Cannot mutate a read-only object');
    return false;
  }

  // A live value's reducer can add or remove keys in place.
  has(target: Record<string, unknown>, prop: string | symbol): boolean {
    this.owner.consume();
    return prop in target;
  }

  ownKeys(target: Record<string, unknown>): ArrayLike<string | symbol> {
    this.owner.consume();
    return Reflect.ownKeys(target);
  }

  getOwnPropertyDescriptor(target: Record<string, unknown>, prop: string | symbol): PropertyDescriptor | undefined {
    return Object.getOwnPropertyDescriptor(target, prop);
  }
}

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

/**
 * Dev builds hand out frozen snapshots. A consumer that mutates one (a
 * `sort()` in render, an assignment) then fails at its own call site with a
 * TypeError and a stack trace, instead of the fast path quietly carrying the
 * mutation forward. Production keeps the objects mutable: freezing costs a
 * call per new container and the contract is documented instead.
 */
function freezeInDev<T extends object>(obj: T): T {
  return IS_DEV ? Object.freeze(obj) : obj;
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
      // `Object.is`, not `!==`: a NaN slot must not mark the array changed on
      // every walk, or the snapshot never reaches a stable identity.
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

/**
 * Structural equality of two snapshot values (plain objects, arrays, and
 * primitives compared with `Object.is`). Used by the dev guard to tell a real
 * drift from a value that merely lost reference identity, e.g. a `Set` a
 * format parser returned, which Signalium's `snapshotSet` rebuilds each walk.
 */
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
    // A rebuilt Set (Signalium's `snapshotSet` copies one every walk) keeps
    // the insertion order, so pair members by position first and only search
    // for a member that fails to line up. This keeps the common case linear.
    const bItems = [...b];
    // Indices of `b` already paired, tracked from the first misalignment on.
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
    // Methods are bound to the proxy and cached on it, so identity is stable.
    into[key] = typeof value === 'function' ? value : snapshotRawValue(value, prevObj?.[key], snap);
  }
}

/**
 * The pre-fast-path walk: `Object.keys` on the proxy and a read per key. Kept
 * for a proxy this module instance did not create — after a hot reload
 * re-evaluates this file, proxies made by the previous instance are still
 * live but absent from the new `snapshotSources`.
 */
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
    // A proxy from another instance of this module (hot reload re-evaluated
    // this file and its registries, but the proxies are still live): walk it
    // the old way rather than handing the proxy back, which would stop React
    // from ever re-rendering on its changes. Every entity proxy answers
    // `toJSON`; a bare `Entity` instance does not.
    if (PROXY_ID.has(current) || typeof (current as { toJSON?: unknown }).toJSON === 'function') {
      return snapshotProxyByWalking(current, prev, snap);
    }
    // An `Entity` that never went through `createProxy` has no fields to read —
    // its own properties are the shape's type defs. Hand it back untouched, the
    // way Signalium treats any class it has no handler for.
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
    // `data` is untouched, so only fields living elsewhere need re-reading.
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
      // Dev builds re-read what the fast path skipped. A field that drifted is
      // served from the re-read (the pre-fast-path behaviour) and reported,
      // rather than thrown: a throw from inside a snapshot lands in Signalium's
      // watcher flush, which has no catch, and stalls every consumer on the page.
      const drifted = verifyStaticFields(source, keys, before, snap);
      if (drifted !== undefined) {
        if (result === undefined) result = { ...before };
        for (const key of Object.keys(drifted)) result[key] = drifted[key];
      }
      // A consumer that added or deleted keys on the snapshot it was handed:
      // rebuild with the shape's keys, in the shape's order, as a walk would.
      // A frozen snapshot (every one this module hands out in dev) cannot
      // have been altered, so only an unfrozen one pays for the key list.
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

/** Dev-only: (typename, field) pairs already reported, so a drift is raised once. */
const reportedDrift = new Set<string>();

export type SnapshotDriftHandler = (error: Error, queryClient: QueryClient) => void;

/**
 * Dev-only default: log through the client's logger, then raise the error
 * outside the snapshot so it surfaces as an uncaught error (a red box in
 * React Native, "Uncaught Error" in a browser, a failed run under vitest)
 * without throwing from inside Signalium's watcher flush, which has no catch
 * and would stop every consumer on the page from updating.
 */
const defaultDriftHandler: SnapshotDriftHandler = (error, queryClient) => {
  queryClient.getContext().log?.error?.(error.message, error);
  queueMicrotask(() => {
    throw error;
  });
};

let snapshotDriftHandler: SnapshotDriftHandler = defaultDriftHandler;

/**
 * Dev-only test hook: replace how a stale snapshot is raised, and forget which
 * fields were already raised. `undefined` restores the default handler.
 */
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
 * function of `data`. Re-reads the skipped fields and returns the ones whose
 * value differs structurally from the cached snapshot (identity alone is not
 * enough: a `Set` from a format parser is rebuilt on every walk), or
 * `undefined` when nothing drifted. Skipped fields only — re-reading a dynamic
 * field is not identity-stable, since snapshotting a child updates state it
 * pairs on.
 *
 * This costs dev builds the read the fast path saved, so the speedup shows up
 * in production builds only.
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
  // This walk is verification, not work the fast path did.
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
  /** Whether this instance has been written to the store. */
  _persisted: boolean = false;
  /** Writes handed to a store that acknowledges them, not yet acknowledged. */
  _pendingWrites: number = 0;
  /** Set while an apply is still reifying this instance's fields; its data is not yet a record. */
  _applying: boolean = false;
  /**
   * The data came from streamed events only (the entity was created by one),
   * so it may lack fields a record of it on disk has: a write merges over
   * that record. Cleared by the first full payload applied to the entity.
   */
  _partial: boolean = false;
  /** With `_partial`: the fields the events carried, i.e. the ones a write merges. */
  _partialKeys: Set<string> | undefined = undefined;
  /** A write requested while a child was still being reified; performed when that apply is done. */
  _deferredWrite: boolean = false;
  /** The store is known to hold a record of this entity (hydrated from it, or written to it). */
  _recorded: boolean = false;
  /** The stored record's fields this instance does not hold; its writes carry them. */
  _recordRest: RecordRest | undefined = undefined;
  /**
   * The stored record handed over at hydration by a store that cannot read
   * it again synchronously, while `_recordRest` has not been taken from it
   * yet: that happens at the first write, so a cold start pays nothing for it.
   */
  private _storedRecord: Record<string, unknown> | undefined = undefined;
  /**
   * The stored record may hold fields of another class sharing the typename
   * (built from a fetch of a class that lacks some, or hydrated from a record
   * that holds some), so the first write reads it (synchronous stores) and
   * keeps them.
   */
  _checkStoredRecord: boolean = false;
  /**
   * `entityRefs` were counted from the whole data by a full payload's apply,
   * not carried over by a partial update or changed by a live collection.
   */
  _refsCounted: boolean = false;
  private _saving: boolean = false;
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
   * This entity's next write drops its reference to `child`, which can delete
   * the child's record. A store that processes writes later (`onPersisted`)
   * does that after anything an apply decides meanwhile, so the child is
   * written again rather than trusted. A synchronous store reports the
   * deletion (`onDelete`) as it happens.
   */
  private writeDropsRef(child: EntityInstance): void {
    if (this._queryClient.storeAcksWrites) child.recordDropped();
  }

  addChildRef(child: EntityInstance, persist: boolean = true): void {
    this._refsCounted = false;
    if (this.entityRefs === undefined) this.entityRefs = new Map();
    const count = this.entityRefs.get(child) ?? 0;
    this.entityRefs.set(child, count + 1);
    if (count === 0) child.retain();
    if (persist) this.save();
  }

  removeChildRef(child: EntityInstance, persist: boolean = true): void {
    this._refsCounted = false;
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

  /** `storeHolds`: what the store's `hasEntity` just said about this entity, if the caller asked. */
  save(storeHolds?: boolean): void {
    const client = this._queryClient;
    if (this._saving) return;
    this._saving = true;
    try {
      // A record's references must point at records that exist: a child the
      // store holds no record of (never written, dropped, or a failed write)
      // is written first. While an apply is still reifying a child (a payload
      // that links back to an ancestor), neither it nor this entity can be
      // written yet: both are written, in that order, once the apply is done.
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
              // This entity's record (if any) still lacks the reference: the
              // next apply must write it again.
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
      // Mark after the store call: a store that throws leaves the record stale
      // or missing, so the flag is cleared and the next apply writes again. A
      // store that acknowledges writes later (`onPersisted`) marks it itself
      // once the write has been processed. An entity built from events hands
      // the store only the fields they carried, to merge over its record.
      // Counted before the call: a store may acknowledge synchronously.
      // With no record to merge over, the fields this entity holds are the
      // whole record, so it stops being partial and later writes skip the
      // merge's read of the stored record.
      if (this._partial && !this._recorded && (storeHolds ?? client.store.hasEntity?.(this.key)) === false) {
        this._partial = false;
        this._partialKeys = undefined;
      }
      if (client.storeAcksWrites) this._pendingWrites++;
      try {
        client.entityMap.save(this, this._partial ? this._partialKeys : undefined);
      } catch (e) {
        this.markUnwritten();
        throw e;
      }
      if (!client.storeAcksWrites) this._persisted = this._recorded = true;
    } finally {
      this._saving = false;
    }
  }

  /** A live field of this entity gained or lost a member outside an apply. */
  liveFieldChanged(fieldKey: string): void {
    if (this._partial) this._partialKeys?.add(fieldKey);
  }

  /**
   * The store processed a write of this entity's record. Only a write this
   * instance dispatched counts: an acknowledgement can also belong to a write
   * queued by a previous instance of the same entity (one that was collected
   * and re-hydrated from the store while the write was in flight), and that
   * write carried a value this instance never had. The record is current
   * once every dispatched write has landed.
   */
  acknowledgeWrite(): void {
    if (this._pendingWrites === 0) return;
    if (--this._pendingWrites === 0) this._persisted = this._recorded = true;
  }

  /** The store dropped (or failed to write) this entity's record. */
  recordDropped(): void {
    this._recorded = false;
    this.markUnwritten();
  }

  /** The store deleted this entity's record, and with it the fields this instance kept from it. */
  recordDeleted(): void {
    this._recordRest = undefined;
    this._storedRecord = undefined;
    this._checkStoredRecord = false;
    this.recordDropped();
  }

  /** Whether this instance keeps fields of its stored record (or reads them, or has the record to take them from). */
  keepsRecordFields(): boolean {
    return this._recordRest !== undefined || this._storedRecord !== undefined || this._checkStoredRecord;
  }

  /**
   * The stored record holds fields the data does not: keep them. A
   * synchronous store's record is read again at the first write rather than
   * held in memory until then.
   */
  recordHoldsOtherFields(record: Record<string, unknown>, rereadable: boolean): void {
    if (rereadable) {
      this._storedRecord = undefined;
      this._recordRest = undefined;
      this._checkStoredRecord = true;
    } else {
      this.noteRecord(record);
    }
  }

  /**
   * Keeps the fields of this entity's stored record (raw, as parsed from the
   * store) that the instance's data does not hold, so its writes carry them.
   * A field the data holds, even as `undefined` (a class declares it and the
   * payload left it out), is the instance's to write. The record is kept as
   * handed over and the fields are taken from it at the first write.
   */
  noteRecord(record: Record<string, unknown>): void {
    this._storedRecord = record;
    this._recordRest = undefined;
  }

  /**
   * The kept record fields to write with the data. Normally exactly what was
   * kept; once a class declaring some of them has been applied, the data
   * holds those itself and they are dropped from what is kept.
   */
  recordRestForWrite(): RecordRest | undefined {
    const data = this.data;
    const record = this._storedRecord;
    if (record !== undefined) {
      this._storedRecord = undefined;
      return (this._recordRest = recordRestOutside(record, data));
    }
    const rest = this._recordRest;
    if (rest === undefined) return undefined;
    const keys = rest.keys;
    for (let i = 0; i < keys.length; i++) {
      if (Object.hasOwn(data, keys[i])) {
        const values = JSON.parse(`{${rest.json}}`) as Record<string, unknown>;
        return (this._recordRest = recordRestOutside(values, data));
      }
    }
    return rest;
  }

  /**
   * Its record is stale: the next apply writes it even if it finds nothing
   * changed. Writes still queued hold older data, so their acknowledgements
   * no longer mark it persisted.
   */
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
  /** Members that do not (yet) satisfy the def; the only ones whose membership can change. */
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
export function isStaticFieldDef(def: unknown): boolean {
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
  /** `enumerable` minus `dynamic` — the fields a version check covers. */
  static: string[];
  enumerableSet: Set<string>;
}

/**
 * A field whose def carries no shape: a primitive, a format, `t.typename`, or
 * a set of literals. Its value can only be a primitive or a format's parsed
 * value, so no other class sharing the typename can put an entity under it.
 */
function isShapelessFieldDef(def: unknown): boolean {
  if (typeof def === 'number' || typeof def === 'string') return true;
  if (def instanceof Set) return true;
  return def instanceof ValidatorDef && (def.shape === undefined || def.shape === null);
}

/**
 * Cached per client (`queryClient.shapeKeyCache`): the split depends on which
 * other classes share the typename, and that set grows as queries register.
 */
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
  // The data object is shared by every class with this typename, so a nested
  // object that is entity-free in this class may hold a child entity written
  // through another class's shape. Only shapeless fields stay static then.
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

/**
 * The members a narrowed array leaves out are dependencies of the read: one
 * of them gaining the def's fields notifies itself, and that is what must
 * recompute the consumer. Members already in the array are read through the
 * array by any consumer that cares about their fields, and a member never
 * loses eligibility, so consuming them here would only add recomputes (and
 * cost a lookup per member on every read of the field).
 */
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
    // The client replaces its key cache when another class registers for
    // this typename, and the new split must reach snapshots already in
    // flight. A cache's entries are never overwritten, so the base can only
    // have changed when the cache object did: an identity check, rather than
    // a WeakMap lookup on every snapshot of every entity. Both extras slots
    // matter too: these lists decide what a snapshot walks and re-reads.
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

      return wrapValue(readField(prop), undefined);
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
