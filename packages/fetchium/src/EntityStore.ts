import { EntityDef } from './types.js';
import type { QueryClient } from './QueryClient.js';
import { EntityInstance } from './EntityInstance.js';
import { ValidatorDef } from './typeDefs.js';

type PersistEntity = (
  key: number,
  data: Record<string, unknown>,
  refKeys?: Set<number>,
  merge?: boolean,
  ifStored?: boolean,
) => void;

export class EntityStore {
  private instances = new Map<number, EntityInstance>();
  private persistEntity: PersistEntity;
  mergesEntities: boolean = false;

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

  /** With `mergeKeys`, only those fields are sent, merged over the stored record. */
  save(instance: EntityInstance, mergeKeys?: Set<string>, ifStored?: boolean): void {
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
    }
    this.persistEntity(instance.key, value, refKeys, merge, ifStored);
  }
}
