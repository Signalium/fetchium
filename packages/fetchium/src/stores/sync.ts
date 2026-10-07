import { CachedQuery, QueryStore, type PreloadedEntityMap } from '../QueryClient.js';
import { QueryDefinition } from '../query.js';
import {
  cacheTimeKeyFor,
  DEFAULT_CACHE_TIME,
  DEFAULT_MAX_COUNT,
  LAST_USED_PREFIX,
  lastUsedKeyFor,
  queueKeyFor,
  refCountKeyFor,
  refIdsKeyFor,
  updatedAtKeyFor,
  valueKeyFor,
  VALUE_PREFIX,
  DOC_PREFIX,
  fieldNamesKeyFor,
  FIELD_NAMES_SINCE_KEY,
  storedRecordRest,
  entityRefsInJson,
} from './shared.js';

export interface SyncPersistentStore {
  has(key: string): boolean;

  getString(key: string): string | undefined;
  setString(key: string, value: string): void;

  getNumber(key: string): number | undefined;
  setNumber(key: string, value: number): void;

  getBuffer(key: string): Uint32Array | undefined;
  setBuffer(key: string, value: Uint32Array): void;

  delete(key: string): void;

  getAllKeys(): string[];
}

export class MemoryPersistentStore implements SyncPersistentStore {
  private readonly kv: Record<string, unknown> = Object.create(null);

  has(key: string): boolean {
    return key in this.kv;
  }

  getString(key: string): string | undefined {
    return this.kv[key] as string | undefined;
  }

  setString(key: string, value: string): void {
    this.kv[key] = value;
  }

  getNumber(key: string): number | undefined {
    return this.kv[key] as number | undefined;
  }

  setNumber(key: string, value: number): void {
    this.kv[key] = value;
  }

  getBuffer(key: string): Uint32Array | undefined {
    return this.kv[key] as Uint32Array | undefined;
  }

  setBuffer(key: string, value: Uint32Array): void {
    this.kv[key] = value;
  }

  delete(key: string): void {
    delete this.kv[key];
  }

  getAllKeys(): string[] {
    return Object.keys(this.kv);
  }
}

/** Keyed by kv, not store: two stores over one kv delete each other's records. */
const deleteListenersByKv = new WeakMap<SyncPersistentStore, Array<(key: number) => void>>();

/** A `mergeEntity()` write's fields and the record's rest, so a same-fields merge skips the read. */
interface MergeRest {
  fields: string;
  json: string;
  refIds: number[];
}

/** Keyed by kv. Writes through any store over it drop entries. Direct kv writes do not. */
const mergeRestsByKv = new WeakMap<SyncPersistentStore, Map<number, MergeRest>>();
/** LRU bound. An evicted record's next merge reads it again. */
const MAX_MERGE_RESTS = 1024;

const fieldNamesByKv = new WeakMap<SyncPersistentStore, Map<string, Map<string, number>>>();
const FIELD_NAME_TTL = 30 * 24 * 60 * 60 * 1000;
const FIELD_NAME_REFRESH = 24 * 60 * 60 * 1000;
/** `at` 0: since `clear()` emptied the kv. */
interface FieldNamesSince {
  at: number;
  stored: boolean;
}
const fieldNamesSinceByKv = new WeakMap<SyncPersistentStore, FieldNamesSince>();

export class SyncQueryStore implements QueryStore {
  queues: Map<string, Uint32Array> = new Map();
  private readonly deleteListeners: Array<(key: number) => void>;
  private readonly mergeRests: Map<number, MergeRest>;
  private readonly fieldNames: Map<string, Map<string, number>>;

  constructor(private readonly kv: SyncPersistentStore) {
    let listeners = deleteListenersByKv.get(kv);
    if (listeners === undefined) {
      listeners = [];
      deleteListenersByKv.set(kv, listeners);
    }
    this.deleteListeners = listeners;
    let rests = mergeRestsByKv.get(kv);
    if (rests === undefined) {
      rests = new Map();
      mergeRestsByKv.set(kv, rests);
    }
    this.mergeRests = rests;
    let fieldNames = fieldNamesByKv.get(kv);
    if (fieldNames === undefined) {
      fieldNames = new Map();
      fieldNamesByKv.set(kv, fieldNames);
    }
    this.fieldNames = fieldNames;
  }

  onDelete(listener: (key: number) => void): () => void {
    this.deleteListeners.push(listener);
    return () => {
      const idx = this.deleteListeners.indexOf(listener);
      if (idx !== -1) this.deleteListeners.splice(idx, 1);
    };
  }

  hasEntity(key: number): boolean {
    return this.kv.has(valueKeyFor(key));
  }

  loadQuery(queryDef: QueryDefinition<any, any, any>, queryKey: number): CachedQuery | undefined {
    const updatedAt = this.kv.getNumber(updatedAtKeyFor(queryKey));

    const cacheTimeMs = (queryDef.statics.cache?.cacheTime ?? DEFAULT_CACHE_TIME) * 60 * 1000;
    if (updatedAt === undefined || updatedAt < Date.now() - cacheTimeMs) {
      return;
    }

    const valueStr = this.kv.getString(valueKeyFor(queryKey));

    if (valueStr === undefined) {
      return;
    }

    const entityIds = this.kv.getBuffer(refIdsKeyFor(queryKey));

    let preloadedEntities: PreloadedEntityMap | undefined;
    if (entityIds !== undefined) {
      preloadedEntities = new Map();
      this.preloadEntities(entityIds, preloadedEntities);
    }

    this.activateQuery(queryDef, queryKey);

    return {
      value: JSON.parse(valueStr) as Record<string, unknown>,
      refIds: entityIds === undefined ? undefined : new Set(entityIds ?? []),
      updatedAt,
      preloadedEntities,
    };
  }

  private preloadEntities(entityIds: Uint32Array, preloaded: PreloadedEntityMap): void {
    for (const entityId of entityIds) {
      // Records can reference each other in a cycle.
      if (preloaded.has(entityId)) continue;
      const entityValue = this.kv.getString(valueKeyFor(entityId));

      if (entityValue === undefined) {
        continue;
      }

      preloaded.set(entityId, JSON.parse(entityValue) as Record<string, unknown>);

      const childIds = this.kv.getBuffer(refIdsKeyFor(entityId));

      if (childIds === undefined) {
        continue;
      }

      this.preloadEntities(childIds, preloaded);
    }
  }

  saveQuery(
    queryDef: QueryDefinition<any, any, any>,
    queryKey: number,
    value: unknown,
    updatedAt: number,
    refIds?: Set<number>,
  ): void {
    this.setValue(queryKey, value, refIds);
    this.kv.setNumber(updatedAtKeyFor(queryKey), updatedAt);
    this.activateQuery(queryDef, queryKey);
  }

  saveEntity(entityKey: number, value: unknown, refIds?: Set<number>, rest?: string): void {
    if (rest === undefined || rest === '') {
      this.setValue(entityKey, value, refIds);
      return;
    }
    // Kept fields go first so a repeated key parses as `value`'s.
    const json = JSON.stringify(value);
    const rests = this.mergeRests;
    if (rests.size !== 0) rests.delete(entityKey);
    this.writeValue(entityKey, json.length === 2 ? `{${rest}}` : `{${rest},${json.slice(1)}`, refIds);
  }

  readEntity(entityKey: number): Record<string, unknown> | undefined {
    const stored = this.kv.getString(valueKeyFor(entityKey));
    if (stored === undefined) return undefined;
    let record: unknown;
    try {
      record = JSON.parse(stored);
    } catch {
      return undefined;
    }
    return typeof record === 'object' && record !== null && !Array.isArray(record)
      ? (record as Record<string, unknown>)
      : undefined;
  }

  getEntityFieldNames(typename: string): readonly string[] | undefined {
    const names = this.fieldNamesOf(typename);
    return names.size === 0 ? undefined : [...names.keys()];
  }

  /**
   * `false` for `FIELD_NAME_TTL` after this version first opens the store,
   * since older records may hold fields of an unregistered class. `clear()`
   * makes it `true`.
   */
  entityFieldNamesComplete(): boolean {
    const at = this.fieldNamesSince().at;
    return at === 0 || Date.now() - at >= FIELD_NAME_TTL;
  }

  private fieldNamesSince(): FieldNamesSince {
    const kv = this.kv;
    let since = fieldNamesSinceByKv.get(kv);
    if (since !== undefined) return since;
    const at = kv.getNumber(FIELD_NAMES_SINCE_KEY);
    if (at !== undefined) {
      since = { at, stored: true };
    } else {
      // Count from now. Telling an empty store apart would need a startup key scan.
      since = { at: Date.now(), stored: false };
    }
    fieldNamesSinceByKv.set(kv, since);
    return since;
  }

  /**
   * Each name keeps when it was last declared, refreshed at most daily. A name
   * undeclared for `FIELD_NAME_TTL` is forgotten.
   */
  addEntityFieldNames(typename: string, fields: readonly string[]): void {
    const names = this.fieldNamesOf(typename);
    const now = Date.now();
    let changed = false;
    for (let i = 0; i < fields.length; i++) {
      const declaredAt = names.get(fields[i]);
      if (declaredAt === undefined || now - declaredAt > FIELD_NAME_REFRESH) {
        names.set(fields[i], now);
        changed = true;
      }
    }
    if (!changed) return;
    const since = this.fieldNamesSince();
    if (!since.stored) {
      this.kv.setNumber(FIELD_NAMES_SINCE_KEY, since.at);
      since.stored = true;
    }
    let stored = '';
    for (const [name, declaredAt] of names) stored += `${stored === '' ? '' : '\n'}${name}\t${declaredAt}`;
    this.kv.setString(fieldNamesKeyFor(typename), stored);
  }

  private fieldNamesOf(typename: string): Map<string, number> {
    let names = this.fieldNames.get(typename);
    if (names !== undefined) return names;
    names = new Map();
    const stored = this.kv.getString(fieldNamesKeyFor(typename));
    if (stored !== undefined && stored !== '') {
      const now = Date.now();
      for (const line of stored.split('\n')) {
        const tab = line.lastIndexOf('\t');
        if (tab <= 0) continue;
        const declaredAt = Number(line.slice(tab + 1));
        if (now - declaredAt <= FIELD_NAME_TTL) names.set(line.slice(0, tab), declaredAt);
      }
    }
    this.fieldNames.set(typename, names);
    return names;
  }

  /**
   * Deletes all cached data and reports each record to `onDelete`. Use this,
   * not the kv's own clear: a client unaware of the deletion would write back
   * fields it kept from deleted records. Field names are kept.
   */
  clear(): void {
    const kv = this.kv;
    const deleted: number[] = [];
    for (const key of kv.getAllKeys()) {
      if (!key.startsWith(DOC_PREFIX)) continue;
      if (key.startsWith(VALUE_PREFIX)) deleted.push(Number(key.slice(VALUE_PREFIX.length)));
      kv.delete(key);
    }
    kv.setNumber(FIELD_NAMES_SINCE_KEY, 0);
    fieldNamesSinceByKv.set(kv, { at: 0, stored: true });
    this.queues.clear();
    this.mergeRests.clear();
    for (let i = 0; i < deleted.length; i++) {
      for (const listener of this.deleteListeners.slice()) listener(deleted[i]);
    }
  }

  mergeEntity(entityKey: number, fields: unknown, refIds?: Set<number>): void {
    const partial = fields as Record<string, unknown>;
    // The fields this write carries: JSON drops the undefined ones.
    let carried = '';
    for (const key in partial) if (partial[key] !== undefined) carried += key + '\n';

    const rests = this.mergeRests;
    let rest = rests.get(entityKey);
    if (rest === undefined || rest.fields !== carried) {
      const stored = this.kv.getString(valueKeyFor(entityKey));
      const split = stored !== undefined ? storedRecordRest(stored, partial) : undefined;
      if (split === undefined) {
        // No record to merge into, or not an object: the fields are the record.
        this.setValue(entityKey, fields, refIds);
        return;
      }
      rest = { fields: carried, json: split.json, refIds: split.refIds };
    }

    let json = JSON.stringify(fields);
    if (rest.json !== '') json = json.length === 2 ? `{${rest.json}}` : `${json.slice(0, -1)},${rest.json}}`;
    const merged = new Set<number>(rest.refIds);
    entityRefsInJson(json, merged);
    this.writeValue(entityKey, json, merged);

    rests.delete(entityKey);
    rests.set(entityKey, rest);
    if (rests.size > MAX_MERGE_RESTS) rests.delete(rests.keys().next().value!);
  }

  activateQuery(queryDef: QueryDefinition<any, any, any>, queryKey: number): void {
    if (!this.kv.has(valueKeyFor(queryKey))) {
      return;
    }

    const queryDefId = queryDef.statics.id;
    let queue = this.queues.get(queryDefId);

    if (queue === undefined) {
      const maxCount = queryDef.statics.cache?.maxCount ?? DEFAULT_MAX_COUNT;
      queue = this.kv.getBuffer(queueKeyFor(queryDefId));

      if (queue === undefined) {
        queue = new Uint32Array(maxCount);
        this.kv.setBuffer(queueKeyFor(queryDefId), queue);
      } else if (queue.length !== maxCount) {
        // A view over the old buffer can't grow, and a shorter one would strand
        // the keys it drops. The activated key moves to the front, so keep it.
        const resized = new Uint32Array(maxCount);
        resized.set(queue.subarray(0, Math.min(queue.length, maxCount)));
        for (let i = maxCount; i < queue.length; i++) {
          const dropped = queue[i];
          if (dropped !== 0 && dropped !== queryKey) {
            this.deleteQuery(dropped);
            this.kv.delete(updatedAtKeyFor(dropped));
          }
        }
        queue = resized;
        this.kv.setBuffer(queueKeyFor(queryDefId), queue);
      }

      this.queues.set(queryDefId, queue);
    }

    this.kv.setNumber(lastUsedKeyFor(queryDefId), Date.now());
    this.kv.setNumber(cacheTimeKeyFor(queryDefId), queryDef.statics.cache?.cacheTime ?? DEFAULT_CACHE_TIME);

    const indexOfKey = queue.indexOf(queryKey);

    if (indexOfKey >= 0) {
      if (indexOfKey === 0) {
        return;
      }
      queue.copyWithin(1, 0, indexOfKey);
      queue[0] = queryKey;
      return;
    }

    const evicted = queue[queue.length - 1];
    queue.copyWithin(1, 0, queue.length - 1);
    queue[0] = queryKey;

    if (evicted !== 0) {
      this.deleteQuery(evicted);
      this.kv.delete(updatedAtKeyFor(evicted));
    }
  }

  purgeStaleQueries(): void {
    const allKeys = this.kv.getAllKeys();
    const now = Date.now();

    for (const key of allKeys) {
      if (!key.startsWith(LAST_USED_PREFIX)) continue;

      const queryDefId = key.slice(LAST_USED_PREFIX.length);
      const lastUsedAt = this.kv.getNumber(key);
      const cacheTime = this.kv.getNumber(cacheTimeKeyFor(queryDefId)) ?? DEFAULT_CACHE_TIME;
      const cacheTimeMs = cacheTime * 60 * 1000;

      if (lastUsedAt === undefined || now - lastUsedAt > cacheTimeMs) {
        const queue = this.kv.getBuffer(queueKeyFor(queryDefId));

        if (queue !== undefined) {
          for (const queryKey of queue) {
            if (queryKey !== 0) {
              this.deleteQuery(queryKey);
              this.kv.delete(updatedAtKeyFor(queryKey));
            }
          }
        }

        this.kv.delete(queueKeyFor(queryDefId));
        this.kv.delete(key);
        this.kv.delete(cacheTimeKeyFor(queryDefId));
        this.queues.delete(queryDefId);
      }
    }
  }

  private setValue(id: number, value: unknown, refIds?: Set<number>): void {
    const rests = this.mergeRests;
    if (rests.size !== 0) rests.delete(id);
    this.writeValue(id, JSON.stringify(value), refIds);
  }

  private writeValue(id: number, json: string, refIds?: Set<number>): void {
    const kv = this.kv;

    kv.setString(valueKeyFor(id), json);

    const refIdsKey = refIdsKeyFor(id);

    const prevRefIds = kv.getBuffer(refIdsKey);

    if (refIds === undefined || refIds.size === 0) {
      kv.delete(refIdsKey);

      // Decrement all previous refs
      if (prevRefIds !== undefined) {
        for (let i = 0; i < prevRefIds.length; i++) {
          const refId = prevRefIds[i];
          this.decrementRefCount(refId);
        }
      }
    } else {
      // Convert the set to a Uint32Array and capture all the refIds before we
      // delete previous ones from the set
      // NOTE: Using spread operator because Hermes (React Native) doesn't correctly
      // handle new Uint32Array(Set) - it produces an empty array instead of converting
      const newRefIds = new Uint32Array([...refIds]);

      if (prevRefIds !== undefined) {
        // Process new refs: increment if not in old
        for (let i = 0; i < prevRefIds.length; i++) {
          const refId = prevRefIds[i];

          if (refIds.has(refId)) {
            refIds.delete(refId);
          } else {
            this.decrementRefCount(refId);
          }
        }
      }

      // No previous refs, increment all unique new refs
      for (const refId of refIds) {
        this.incrementRefCount(refId);
      }

      kv.setBuffer(refIdsKey, newRefIds);
    }
  }

  deleteQuery(id: number): void {
    const kv = this.kv;
    const rests = this.mergeRests;
    if (rests.size !== 0) rests.delete(id);

    kv.delete(valueKeyFor(id));
    kv.delete(refCountKeyFor(id));
    // A listener may unsubscribe while being notified.
    for (const listener of this.deleteListeners.slice()) listener(id);

    const refIds = kv.getBuffer(refIdsKeyFor(id));
    kv.delete(refIdsKeyFor(id)); // Clean up the refIds key

    if (refIds === undefined) {
      return;
    }

    // Decrement ref counts for all referenced entities
    for (const refId of refIds) {
      if (refId !== 0) {
        this.decrementRefCount(refId);
      }
    }
  }

  private incrementRefCount(refId: number): void {
    const refCountKey = refCountKeyFor(refId);
    const currentCount = this.kv.getNumber(refCountKey) ?? 0;
    const newCount = currentCount + 1;
    this.kv.setNumber(refCountKey, newCount);
  }

  private decrementRefCount(refId: number): void {
    const refCountKey = refCountKeyFor(refId);
    const currentCount = this.kv.getNumber(refCountKey);

    if (currentCount === undefined) {
      // Already deleted or never existed
      return;
    }

    const newCount = currentCount - 1;

    if (newCount === 0) {
      // Entity exists, cascade delete it
      this.deleteQuery(refId);
    } else {
      this.kv.setNumber(refCountKey, newCount);
    }
  }
}
