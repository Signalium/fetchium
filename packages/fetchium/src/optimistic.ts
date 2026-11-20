import { hashValue } from 'signalium/utils';
import type { QueryClient } from './QueryClient.js';
import type { EntityInstance } from './EntityInstance.js';
import type { MutationEvent } from './types.js';
import { FormattedValue, WrappedValue } from './typeDefs.js';
import { PROXY_ID } from './proxyId.js';
import { sameValue } from './applyEntities.js';

const UNTRACKABLE = Symbol('untrackable');

interface Layer {
  owner: object;
  value: unknown;
}

/** `base` is the value to restore once every layer is gone. */
interface FieldState {
  base: unknown;
  layers: Layer[];
}

export type OptimisticUndo =
  | { kind: 'fields'; typename: string; idField: string; id: unknown; key: number; fields: string[] }
  | { kind: 'remove'; typename: string; idField: string; id: unknown }
  | { kind: 'reroute'; typename: string; entity: EntityInstance };

interface Target {
  key: number;
  id: unknown;
  idField: string;
  typenameField: string | undefined;
  shape: Record<string, unknown>;
}

/**
 * Optimistic entity writes, stacked per field so each mutation call undoes only
 * its own. Values are kept in raw (pre-format) form so they can be replayed as events.
 */
export class OptimisticLayers {
  private states = new Map<number, Map<string, FieldState>>();

  constructor(private qc: QueryClient) {}

  apply(owner: object, event: MutationEvent): OptimisticUndo | undefined {
    const qc = this.qc;
    const target = this.resolve(event);
    if (target === undefined) return undefined;
    const { key, id, idField } = target;
    const typename = event.typename;
    const existing = qc.entityMap.getEntity(key);

    if (event.type === 'delete') {
      // Live arrays hold only in-memory entities, so deleting any other changes nothing.
      if (existing === undefined) {
        qc.applyMutationEvent(event);
        return undefined;
      }
      // Kept in memory so a rollback can route it back.
      existing.retain();
      qc.applyMutationEvent(event);
      return { kind: 'reroute', typename, entity: existing };
    }

    if (existing === undefined) {
      qc.applyMutationEvent(event);
      return event.type === 'create' ? { kind: 'remove', typename, idField, id } : undefined;
    }

    let fieldStates = this.states.get(key);
    const pending: Array<[string, FieldState]> = [];
    for (const field of Object.keys(event.data)) {
      if (field === idField || field === target.typenameField || !(field in target.shape)) continue;
      let state = fieldStates?.get(field);
      if (state === undefined) {
        // An absent field can't be written back.
        if (!(field in existing.data)) continue;
        const base = toRaw(existing.data[field], qc);
        if (base === UNTRACKABLE) continue;
        state = { base, layers: [] };
      }
      pending.push([field, state]);
    }

    qc.applyMutationEvent(event);

    const entity = qc.entityMap.getEntity(key);
    if (entity === undefined || pending.length === 0) return undefined;
    fieldStates ??= new Map();
    this.states.set(key, fieldStates);
    const fields: string[] = [];
    for (const [field, state] of pending) {
      state.layers.push({ owner, value: toRaw(entity.data[field], qc) });
      fieldStates.set(field, state);
      fields.push(field);
    }
    return { kind: 'fields', typename, idField, id, key, fields };
  }

  /**
   * Prepares a confirmed (server) event from `owner`. A field another call is
   * still holding optimistically, and that `owner` didn't write last, keeps its
   * visible value; the server value becomes what that field restores to.
   */
  confirm(owner: object, event: MutationEvent): MutationEvent {
    if (event.type === 'delete' || this.states.size === 0) return event;
    const target = this.resolve(event);
    const fieldStates = target === undefined ? undefined : this.states.get(target.key);
    if (fieldStates === undefined) return event;

    let data: Record<string, unknown> | undefined;
    for (const field of Object.keys(event.data)) {
      const state = fieldStates.get(field);
      if (state === undefined) continue;
      state.base = event.data[field];
      const own = state.layers.findIndex(l => l.owner === owner);
      if (own === state.layers.length - 1) continue;
      data ??= { ...event.data };
      delete data[field];
    }
    return data === undefined ? event : { ...event, data };
  }

  /** Drops `owner`'s layers after its request succeeds. */
  release(owner: object, undos: OptimisticUndo[]): void {
    for (const undo of undos) {
      if (undo.kind === 'reroute') undo.entity.release();
      if (undo.kind !== 'fields') continue;
      for (const field of undo.fields) this.removeLayer(undo.key, field, owner);
    }
  }

  /** Undoes `owner`'s writes after its request fails, newest first. */
  rollback(owner: object, undos: OptimisticUndo[]): void {
    const qc = this.qc;
    for (let i = undos.length - 1; i >= 0; i--) {
      const undo = undos[i];
      if (undo.kind === 'remove') {
        qc.applyMutationEvent({
          type: 'delete',
          typename: undo.typename,
          id: undo.id,
          data: { [undo.idField]: undo.id },
        });
        continue;
      }
      if (undo.kind === 'reroute') {
        qc.rerouteAsCreated(undo.typename, undo.entity.key);
        undo.entity.release();
        continue;
      }

      const entity = qc.entityMap.getEntity(undo.key);
      let write: Record<string, unknown> | undefined;
      for (const field of undo.fields) {
        const removed = this.removeLayer(undo.key, field, owner);
        if (removed === undefined || entity === undefined) continue;
        const { layer, state } = removed;
        // Leave a value something else wrote since, such as a stream update or a later call.
        if (!sameValue(toRaw(entity.data[field], qc), layer.value)) continue;
        (write ??= {})[field] = state.layers.length > 0 ? state.layers[state.layers.length - 1].value : state.base;
      }
      if (write !== undefined) {
        qc.applyMutationEvent({
          type: 'update',
          typename: undo.typename,
          id: undo.id,
          data: { ...write, [undo.idField]: undo.id },
        });
      }
    }
  }

  private removeLayer(key: number, field: string, owner: object): { layer: Layer; state: FieldState } | undefined {
    const fieldStates = this.states.get(key);
    const state = fieldStates?.get(field);
    if (state === undefined) return undefined;
    const index = state.layers.findIndex(l => l.owner === owner);
    if (index === -1) return undefined;
    const [layer] = state.layers.splice(index, 1);
    if (state.layers.length === 0) {
      fieldStates!.delete(field);
      if (fieldStates!.size === 0) this.states.delete(key);
    }
    return { layer, state };
  }

  private resolve(event: MutationEvent): Target | undefined {
    const def = this.qc.getMergedDef(event.typename);
    if (def === undefined) return undefined;
    const { idField, typenameField } = def as unknown as { idField: unknown; typenameField: string | undefined };
    if (typeof idField !== 'string') return undefined;
    const raw = event.data;
    const id =
      event.id !== undefined
        ? event.id
        : typeof raw === 'string' || typeof raw === 'number'
          ? raw
          : (raw as Record<string, unknown>)[idField];
    if (id === undefined) return undefined;
    return {
      key: hashValue([event.typename, id]),
      id,
      idField,
      typenameField,
      shape: (def.shape ?? {}) as Record<string, unknown>,
    };
  }
}

/** Stored entity value → event payload. Live collections can't be replayed. */
function toRaw(value: unknown, qc: QueryClient): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof FormattedValue) return value._raw;
  if (value instanceof WrappedValue) return UNTRACKABLE;

  const source = PROXY_ID.get(value);
  if (source !== undefined) {
    const { typename, id, idField } = source.instance;
    if (typeof idField !== 'string') return UNTRACKABLE;
    const typenameField = (qc.getMergedDef(typename) as unknown as { typenameField?: string } | undefined)
      ?.typenameField;
    return typenameField === undefined ? { [idField]: id } : { [typenameField]: typename, [idField]: id };
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const raw = toRaw(item, qc);
      if (raw === UNTRACKABLE) return UNTRACKABLE;
      out.push(raw);
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value)) {
    const raw = toRaw((value as Record<string, unknown>)[k], qc);
    if (raw === UNTRACKABLE) return UNTRACKABLE;
    out[k] = raw;
  }
  return out;
}
