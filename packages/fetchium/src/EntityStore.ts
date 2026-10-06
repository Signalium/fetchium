import { EntityDef } from './types.js';
import type { QueryClient } from './QueryClient.js';
import { EntityInstance } from './EntityInstance.js';
import { ValidatorDef } from './typeDefs.js';

export class EntityStore {
  private instances = new Map<number, EntityInstance>();
  private persistEntity: PersistEntity;
  /** Whether the store can merge fields over a record it holds. */
  mergesEntities: boolean = false;
  /** A synchronous store's read of an entity's stored record, if it offers one (see `QueryStore.readEntity`). */
  readEntity: ((key: number, fields?: readonly string[]) => Record<string, unknown> | undefined) | undefined =
    undefined;

  constructor(persistEntity: PersistEntity) {
    this.persistEntity = persistEntity;
  }

  hasEntity(key: number): boolean {
    return this.instances.has(key);
  }

  getEntity(key: number): EntityInstance | undefined {
    return this.instances.get(key);
  }

  getOrCreateEntity(
    key: number,
    data: Record<string, unknown>,
    shape: EntityDef,
    queryClient: QueryClient,
  ): EntityInstance {
    let instance = this.instances.get(key);

    if (instance === undefined) {
      const idField = shape.idField;
      if (idField === undefined) {
        throw new Error(`Entity id field is required ${shape.typenameValue}`);
      }

      const id = (data as Record<string | symbol, unknown>)[idField];
      if (typeof id !== 'string' && typeof id !== 'number') {
        throw new Error(`Entity id must be string or number: ${shape.typenameValue}`);
      }

      const validatorDef = shape as unknown as ValidatorDef<unknown>;

      instance = new EntityInstance(key, shape.typenameValue!, id, idField, data, queryClient);
      instance._entityCache = validatorDef._entityCache;
      this.instances.set(key, instance);
    }

    instance.parseId = queryClient.currentParseId;

    return instance;
  }

  remove(key: number): void {
    this.instances.delete(key);
  }

  clear(): void {
    this.instances.clear();
  }

  /**
   * With `mergeKeys`, only those fields are handed to the store, to be merged
   * over the record it holds (the rest of the instance's data is what streamed
   * events left unset, not what the record says).
   */
  save(instance: EntityInstance, mergeKeys?: Set<string>): void {
    let refKeys: Set<number> | undefined;
    if (instance.entityRefs) {
      refKeys = new Set<number>();
      // A child evicted from memory has no record to reference.
      for (const e of instance.entityRefs.keys()) if (this.instances.get(e.key) === e) refKeys.add(e.key);
    }
    let value = instance.data;
    const merge = mergeKeys !== undefined && this.mergesEntities;
    if (merge) {
      value = {};
      for (const k of mergeKeys) value[k] = instance.data[k];
      this.persistEntity(instance.key, value, refKeys, true);
      return;
    }
    if (instance._checkStoredRecord) {
      // First write of an instance whose class may lack fields the record
      // holds: read the record once and keep them from now on.
      instance._checkStoredRecord = false;
      const stored = this.readEntity?.(instance.key, instance._recordProbe);
      instance._recordProbe = undefined;
      if (stored !== undefined) instance.noteRecord(stored);
    }
    const rest = instance.recordRestForWrite();
    if (rest !== undefined && rest.refIds.length > 0) {
      refKeys ??= new Set<number>();
      for (let i = 0; i < rest.refIds.length; i++) refKeys.add(rest.refIds[i]);
    }
    this.persistEntity(instance.key, value, refKeys, false, rest?.json);
  }
}

type PersistEntity = (
  key: number,
  data: Record<string, unknown>,
  refKeys: Set<number> | undefined,
  merge: boolean,
  rest?: string,
) => void;
