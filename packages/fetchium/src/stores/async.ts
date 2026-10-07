import { QueryDefinition } from '../query.js';
import { CachedQuery, QueryStore, type PreloadedEntityMap } from '../QueryClient.js';
import {
  cacheTimeKeyFor,
  DEFAULT_CACHE_TIME,
  DEFAULT_MAX_COUNT,
  LAST_USED_PREFIX,
  lastUsedKeyFor,
  mergeStoredRecord,
  queueKeyFor,
  refCountKeyFor,
  refIdsKeyFor,
  updatedAtKeyFor,
  VALUE_PREFIX,
  valueKeyFor,
} from './shared.js';

// -----------------------------------------------------------------------------
// Async QueryStore Interfaces
// -----------------------------------------------------------------------------

export interface AsyncPersistentStore {
  has(key: string): Promise<boolean>;

  getString(key: string): Promise<string | undefined>;
  setString(key: string, value: string): Promise<void>;

  getNumber(key: string): Promise<number | undefined>;
  setNumber(key: string, value: number): Promise<void>;

  getBuffer(key: string): Promise<Uint32Array | undefined>;
  setBuffer(key: string, value: Uint32Array): Promise<void>;

  delete(key: string): Promise<void>;

  getAllKeys(): Promise<string[]>;
}

const enum StoreMessageType {
  SaveQuery = 0,
  SaveEntity = 1,
  ActivateQuery = 2,
  DeleteQuery = 3,
}

export type StoreMessage =
  | {
      type: StoreMessageType.SaveQuery;
      queryDefId: string;
      queryKey: number;
      value: unknown;
      updatedAt: number;
      cacheTime: number;
      /** Absent on the wire from readers built before 0.6; the writer then keeps the persisted queue's size. */
      maxCount?: number;
      refIds?: number[];
    }
  | {
      type: StoreMessageType.SaveEntity;
      entityKey: number;
      value: unknown;
      refIds?: number[];
      /** `value` holds only some fields; the writer merges them over the stored record, if any. */
      merge?: boolean;
      /**
       * Fields of the stored record to keep alongside `value`, as a JSON
       * object body (see `QueryStore.saveEntity`). An older writer ignores it
       * and writes `value` alone.
       */
      rest?: string;
    }
  | { type: StoreMessageType.ActivateQuery; queryDefId: string; queryKey: number; cacheTime: number; maxCount?: number }
  | { type: StoreMessageType.DeleteQuery; queryKey: number };

export interface AsyncQueryStoreConfig {
  isWriter: boolean;
  connect: (handleMessage: (msg: StoreMessage) => void) => {
    sendMessage: (msg: StoreMessage) => void;
  };
  delegate?: AsyncPersistentStore; // Only provided for writer
}

/**
 * Writer-internal work run through the same serial queue as wire messages, so
 * it is ordered with the writes and deletions around it. Never sent over the
 * wire.
 */
class InternalWork {
  constructor(
    readonly run: () => Promise<void>,
    readonly resolve: () => void,
    readonly reject: (error: unknown) => void,
  ) {}
}

type QueuedWork = StoreMessage | InternalWork;

/** Whether something received on the channel is a message this writer handles. */
function isStoreMessage(msg: unknown): msg is StoreMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const type = (msg as { type?: unknown }).type;
  return (
    type === StoreMessageType.SaveQuery ||
    type === StoreMessageType.SaveEntity ||
    type === StoreMessageType.ActivateQuery ||
    type === StoreMessageType.DeleteQuery
  );
}

function subscribe(listeners: Array<(key: number) => void>, listener: (key: number) => void): () => void {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx !== -1) listeners.splice(idx, 1);
  };
}

// -----------------------------------------------------------------------------
// Async QueryStore Implementation
// -----------------------------------------------------------------------------

export class AsyncQueryStore implements QueryStore {
  private readonly isWriter: boolean;
  private readonly delegate?: AsyncPersistentStore;
  private readonly sendMessage: (msg: StoreMessage) => void;
  private readonly messageQueue: QueuedWork[] = [];
  private readonly queues: Map<string, Uint32Array> = new Map();
  private queueProcessorPromise?: Promise<void>;
  private resolveQueueWait?: () => void;
  private deleteListeners: Array<(key: number) => void> = [];
  private persistedListeners: Array<(key: number) => void> = [];
  private processing = false;
  // Queued work that can delete a record: everything except this writer's
  // own client's entity writes, whose dropped references the client tracks.
  private queuedDeletes = 0;
  private readonly ownEntityWrites = new WeakSet<QueuedWork>();
  // Ids whose value the delegate holds (queued writes included), mirrored so
  // `hasEntity` can answer synchronously. Read from the delegate once at
  // start without blocking the queue. Writes and deletions before that read
  // lands are noted aside and folded in.
  private heldKeys: Set<number> | undefined;
  private heldSinceScan: Set<number> | undefined = new Set();
  private droppedSinceScan: Set<number> | undefined = new Set();
  // Only the writer sees deletions and completed writes. A reader offers no
  // hooks, so the client writes every apply.
  onDelete?: (listener: (key: number) => void) => () => void;
  onPersisted?: (listener: (key: number) => void) => () => void;
  hasEntity?: (key: number) => boolean | undefined;
  hasQueuedDeletes?: () => boolean;

  constructor(config: AsyncQueryStoreConfig) {
    this.isWriter = config.isWriter;
    this.delegate = config.delegate;
    if (this.isWriter) {
      this.onDelete = listener => subscribe(this.deleteListeners, listener);
      this.onPersisted = listener => subscribe(this.persistedListeners, listener);
      this.hasQueuedDeletes = () => this.queuedDeletes > 0;
      this.hasEntity = key => {
        if (this.heldKeys !== undefined) return this.heldKeys.has(key);
        // Not read yet: only what this writer itself wrote is known.
        return this.heldSinceScan!.has(key) ? true : undefined;
      };
    }

    // Connect and get sendMessage function
    const { sendMessage } = config.connect(this.handleMessage.bind(this));
    this.sendMessage = sendMessage;

    // Start queue processor if this is a writer
    if (this.isWriter) {
      if (!this.delegate) {
        throw new Error('Writer must have a delegate');
      }
      void this.scanHeldKeys();
      this.startQueueProcessor();
    }
  }

  /** Queues writer-internal work behind everything already queued. */
  private runInternal(run: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.enqueueMessage(new InternalWork(run, resolve, reject));
    });
  }

  private handleMessage(msg: StoreMessage): void {
    if (!this.isWriter) return; // Readers don't handle incoming messages
    if (!isStoreMessage(msg)) {
      console.error('Ignoring a message the store does not understand:', msg);
      return;
    }
    // Enqueue the message for serial processing
    this.enqueueMessage(msg);
  }

  private enqueueMessage(msg: QueuedWork): void {
    if (!this.ownEntityWrites.has(msg)) this.queuedDeletes++;
    this.messageQueue.push(msg);
    // Wake up the queue processor if it's waiting
    if (this.resolveQueueWait) {
      this.resolveQueueWait();
      this.resolveQueueWait = undefined;
    }
  }

  private dispatch(msg: StoreMessage): void {
    if (this.isWriter) {
      if (msg.type === StoreMessageType.SaveEntity) {
        this.noteHeld(msg.entityKey);
        this.ownEntityWrites.add(msg);
      }
      this.enqueueMessage(msg);
    } else {
      this.sendMessage(msg);
    }
  }

  private noteHeld(id: number): void {
    if (this.heldKeys !== undefined) this.heldKeys.add(id);
    else {
      this.heldSinceScan!.add(id);
      this.droppedSinceScan!.delete(id);
    }
  }

  private noteDropped(id: number): void {
    if (this.heldKeys !== undefined) this.heldKeys.delete(id);
    else {
      this.heldSinceScan!.delete(id);
      this.droppedSinceScan!.add(id);
    }
  }

  private startQueueProcessor(): void {
    this.queueProcessorPromise = this.processQueue();
  }

  private async processQueue(): Promise<void> {
    while (true) {
      // Wait for messages if queue is empty
      while (this.messageQueue.length === 0) {
        await new Promise<void>(resolve => {
          this.resolveQueueWait = resolve;
        });
      }

      // Process one message at a time
      const msg = this.messageQueue.shift()!;

      this.processing = true;
      try {
        if (msg instanceof InternalWork) {
          try {
            await msg.run();
            msg.resolve();
          } catch (error) {
            msg.reject(error);
          }
        } else {
          await this.processMessage(msg);
        }
      } catch (error) {
        console.error('Error processing message:', error);
        // A failed entity write leaves the record missing or stale. Report it
        // as dropped so the client writes the entity again on its next apply.
        if (!(msg instanceof InternalWork) && msg.type === StoreMessageType.SaveEntity) {
          this.noteDropped(msg.entityKey);
          for (let i = 0; i < this.deleteListeners.length; i++) this.deleteListeners[i](msg.entityKey);
        }
      } finally {
        this.processing = false;
        if (!this.ownEntityWrites.has(msg)) this.queuedDeletes--;
      }
    }
  }

  /**
   * Reads which records the delegate holds, alongside the queue rather than
   * ahead of it. Writes and deletions processed meanwhile are folded in.
   * A failed read is retried. If it keeps failing nothing is assumed held, so
   * an event for an entity not in memory is not written.
   */
  private async scanHeldKeys(): Promise<void> {
    const held = new Set<number>();
    for (let attempt = 0; ; attempt++) {
      try {
        for (const key of await this.delegate!.getAllKeys()) {
          if (!key.startsWith(VALUE_PREFIX)) continue;
          const id = Number(key.slice(VALUE_PREFIX.length));
          if (Number.isInteger(id)) held.add(id);
        }
        break;
      } catch (error) {
        if (attempt >= 2) {
          console.error('Could not read the keys the store holds:', error);
          held.clear();
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50 << attempt));
      }
    }
    for (const id of this.heldSinceScan!) held.add(id);
    for (const id of this.droppedSinceScan!) held.delete(id);
    this.heldKeys = held;
    this.heldSinceScan = this.droppedSinceScan = undefined;
  }

  /**
   * Whether every operation handed to this store has been applied. Readers
   * hand their operations to a writer elsewhere and never skip writes anyway.
   */
  isSettled(): boolean {
    return !this.isWriter || (this.messageQueue.length === 0 && !this.processing);
  }

  private async processMessage(msg: StoreMessage): Promise<void> {
    switch (msg.type) {
      case StoreMessageType.SaveQuery:
        await this.writerSaveQuery(
          msg.queryDefId,
          msg.queryKey,
          msg.value,
          msg.updatedAt,
          msg.cacheTime,
          msg.maxCount,
          msg.refIds,
        );
        break;
      case StoreMessageType.SaveEntity:
        await this.writerSaveEntity(msg.entityKey, msg.value, msg.refIds, msg.merge === true, msg.rest);
        for (let i = 0; i < this.persistedListeners.length; i++) this.persistedListeners[i](msg.entityKey);
        break;
      case StoreMessageType.ActivateQuery:
        await this.writerActivateQuery(msg.queryDefId, msg.queryKey, msg.cacheTime, msg.maxCount);
        break;
      case StoreMessageType.DeleteQuery:
        await this.writerDeleteValue(msg.queryKey);
        break;
    }
  }

  async loadQuery(queryDef: QueryDefinition<any, any, any>, queryKey: number): Promise<CachedQuery | undefined> {
    if (!this.delegate) {
      return undefined;
    }

    const updatedAt = await this.delegate.getNumber(updatedAtKeyFor(queryKey));

    const cacheTimeMs = (queryDef.statics.cache?.cacheTime ?? DEFAULT_CACHE_TIME) * 60 * 1000;
    if (updatedAt === undefined || updatedAt < Date.now() - cacheTimeMs) {
      return undefined;
    }

    const valueStr = await this.delegate.getString(valueKeyFor(queryKey));

    if (valueStr === undefined) {
      return undefined;
    }

    const entityIds = await this.delegate.getBuffer(refIdsKeyFor(queryKey));

    let preloadedEntities: PreloadedEntityMap | undefined;
    if (entityIds !== undefined) {
      preloadedEntities = new Map();
      await this.preloadEntities(entityIds, preloadedEntities);
    }

    this.activateQuery(queryDef, queryKey);

    return {
      value: JSON.parse(valueStr) as Record<string, unknown>,
      refIds: entityIds === undefined ? undefined : new Set(entityIds ?? []),
      updatedAt,
      preloadedEntities,
    };
  }

  private async preloadEntities(entityIds: Uint32Array, preloaded: PreloadedEntityMap): Promise<void> {
    if (!this.delegate) {
      return;
    }

    for (const entityId of entityIds) {
      // Records can reference each other in a cycle (a file whose record
      // links back to its folder); one read per record.
      if (preloaded.has(entityId)) continue;
      const entityValue = await this.delegate.getString(valueKeyFor(entityId));

      if (entityValue === undefined) {
        continue;
      }

      preloaded.set(entityId, JSON.parse(entityValue) as Record<string, unknown>);

      const childIds = await this.delegate.getBuffer(refIdsKeyFor(entityId));

      if (childIds === undefined) {
        continue;
      }

      await this.preloadEntities(childIds, preloaded);
    }
  }

  saveQuery(
    queryDef: QueryDefinition<any, any, any>,
    queryKey: number,
    value: unknown,
    updatedAt: number,
    refIds?: Set<number>,
  ): void {
    const message: StoreMessage = {
      type: StoreMessageType.SaveQuery,
      queryDefId: queryDef.statics.id,
      queryKey,
      value,
      updatedAt,
      cacheTime: queryDef.statics.cache?.cacheTime ?? DEFAULT_CACHE_TIME,
      maxCount: queryDef.statics.cache?.maxCount ?? DEFAULT_MAX_COUNT,
      refIds: refIds ? Array.from(refIds) : undefined,
    };

    this.dispatch(message);
  }

  saveEntity(entityKey: number, value: unknown, refIds?: Set<number>, rest?: string): void {
    const message: Extract<StoreMessage, { type: StoreMessageType.SaveEntity }> = {
      type: StoreMessageType.SaveEntity,
      entityKey,
      value,
      refIds: refIds ? Array.from(refIds) : undefined,
    };
    if (rest !== undefined && rest !== '') message.rest = rest;
    this.dispatch(message);
  }

  mergeEntity(entityKey: number, fields: unknown, refIds?: Set<number>): void {
    this.dispatch({
      type: StoreMessageType.SaveEntity,
      entityKey,
      value: fields,
      refIds: refIds ? Array.from(refIds) : undefined,
      merge: true,
    });
  }

  activateQuery(queryDef: QueryDefinition<any, any, any>, queryKey: number): void {
    const message: StoreMessage = {
      type: StoreMessageType.ActivateQuery,
      queryDefId: queryDef.statics.id,
      queryKey,
      cacheTime: queryDef.statics.cache?.cacheTime ?? DEFAULT_CACHE_TIME,
      maxCount: queryDef.statics.cache?.maxCount ?? DEFAULT_MAX_COUNT,
    };

    this.dispatch(message);
  }

  deleteQuery(queryKey: number): void {
    const message: StoreMessage = {
      type: StoreMessageType.DeleteQuery,
      queryKey,
    };

    this.dispatch(message);
  }

  // Writer-specific methods below

  private async writerSaveQuery(
    queryDefId: string,
    queryKey: number,
    value: unknown,
    updatedAt: number,
    cacheTime: number,
    maxCount: number | undefined,
    refIds?: number[],
  ): Promise<void> {
    await this.setValue(queryKey, value, refIds ? new Set(refIds) : undefined);
    await this.delegate!.setNumber(updatedAtKeyFor(queryKey), updatedAt);
    await this.writerActivateQuery(queryDefId, queryKey, cacheTime, maxCount);
  }

  private async writerSaveEntity(
    entityKey: number,
    value: unknown,
    refIds: number[] | undefined,
    merge: boolean,
    rest?: string,
  ): Promise<void> {
    if (merge) {
      const stored = await this.delegate!.getString(valueKeyFor(entityKey));
      const merged = stored !== undefined ? mergeStoredRecord(stored, value) : undefined;
      if (merged !== undefined) {
        await this.setValue(entityKey, merged.value, merged.refIds);
        return;
      }
    }
    await this.setValue(entityKey, value, refIds ? new Set(refIds) : undefined, rest);
  }

  private async writerActivateQuery(
    queryDefId: string,
    queryKey: number,
    cacheTime: number,
    maxCount: number | undefined,
  ): Promise<void> {
    if (!(await this.delegate!.has(valueKeyFor(queryKey)))) {
      return;
    }

    const queueKey = queueKeyFor(queryDefId);
    let queue = this.queues.get(queryDefId);

    if (queue === undefined) {
      queue = await this.delegate!.getBuffer(queueKey);

      if (queue === undefined) {
        queue = new Uint32Array(maxCount ?? DEFAULT_MAX_COUNT);
        await this.delegate!.setBuffer(queueKey, queue);
      } else if (maxCount !== undefined && queue.length !== maxCount) {
        // `maxCount` changed since the queue was written (writers before 0.6
        // always used the default of 50). A view over the old buffer can't
        // grow, and a shorter one would strand the keys it drops: copy what
        // fits and evict the rest. The key being activated moves to the
        // front, so it is kept wherever it sits.
        const resized = new Uint32Array(maxCount);
        resized.set(queue.subarray(0, Math.min(queue.length, maxCount)));
        for (let i = maxCount; i < queue.length; i++) {
          const dropped = queue[i];
          if (dropped !== 0 && dropped !== queryKey) {
            await this.writerDeleteValue(dropped);
            await this.delegate!.delete(updatedAtKeyFor(dropped));
          }
        }
        queue = resized;
        await this.delegate!.setBuffer(queueKey, queue);
      }

      this.queues.set(queryDefId, queue);
    }

    await this.delegate!.setNumber(lastUsedKeyFor(queryDefId), Date.now());
    await this.delegate!.setNumber(cacheTimeKeyFor(queryDefId), cacheTime);

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
      await this.writerDeleteValue(evicted);
      await this.delegate!.delete(updatedAtKeyFor(evicted));
    }
  }

  /**
   * Drops every query definition's cached queries once the definition has
   * gone unused for its `cacheTime`. Runs through the writer's serial queue,
   * so a record it drops cannot be reported as written afterwards.
   */
  purgeStaleQueries(): Promise<void> {
    if (!this.delegate) return Promise.resolve();
    if (!this.isWriter) return this.purgeStaleQueriesNow();
    return this.runInternal(() => this.purgeStaleQueriesNow());
  }

  private async purgeStaleQueriesNow(): Promise<void> {
    if (!this.delegate) return;

    const allKeys = await this.delegate.getAllKeys();
    const now = Date.now();

    for (const key of allKeys) {
      if (!key.startsWith(LAST_USED_PREFIX)) continue;

      const queryDefId = key.slice(LAST_USED_PREFIX.length);
      const lastUsedAt = await this.delegate.getNumber(key);
      const cacheTime = (await this.delegate.getNumber(cacheTimeKeyFor(queryDefId))) ?? DEFAULT_CACHE_TIME;
      const cacheTimeMs = cacheTime * 60 * 1000;

      if (lastUsedAt === undefined || now - lastUsedAt > cacheTimeMs) {
        const queue = await this.delegate.getBuffer(queueKeyFor(queryDefId));

        if (queue !== undefined) {
          for (const queryKey of queue) {
            if (queryKey !== 0) {
              await this.writerDeleteValue(queryKey);
              await this.delegate.delete(updatedAtKeyFor(queryKey));
            }
          }
        }

        await this.delegate.delete(queueKeyFor(queryDefId));
        await this.delegate.delete(key);
        await this.delegate.delete(cacheTimeKeyFor(queryDefId));
        this.queues.delete(queryDefId);
      }
    }
  }

  /** `rest`: fields of the stored record to keep, written ahead of `value`'s (see `QueryStore.saveEntity`). */
  private async setValue(id: number, value: unknown, refIds?: Set<number>, rest?: string): Promise<void> {
    const delegate = this.delegate!;

    let json = JSON.stringify(value);
    if (rest !== undefined && rest !== '') json = json.length === 2 ? `{${rest}}` : `{${rest},${json.slice(1)}`;
    await delegate.setString(valueKeyFor(id), json);
    this.noteHeld(id);

    const refIdsKey = refIdsKeyFor(id);

    const prevRefIds = await delegate.getBuffer(refIdsKey);

    if (refIds === undefined || refIds.size === 0) {
      await delegate.delete(refIdsKey);

      // Decrement all previous refs
      if (prevRefIds !== undefined) {
        for (let i = 0; i < prevRefIds.length; i++) {
          const refId = prevRefIds[i];
          await this.decrementRefCount(refId);
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
            await this.decrementRefCount(refId);
          }
        }
      }

      // No previous refs, increment all unique new refs
      for (const refId of refIds) {
        await this.incrementRefCount(refId);
      }

      await delegate.setBuffer(refIdsKey, newRefIds);
    }
  }

  private async writerDeleteValue(id: number): Promise<void> {
    const delegate = this.delegate!;
    const refIdsKey = refIdsKeyFor(id);

    await delegate.delete(valueKeyFor(id));
    this.noteDropped(id);
    await delegate.delete(refCountKeyFor(id));
    for (let i = 0; i < this.deleteListeners.length; i++) this.deleteListeners[i](id);

    const refIds = await delegate.getBuffer(refIdsKey);
    await delegate.delete(refIdsKey); // Clean up the refIds key

    if (refIds === undefined) {
      return;
    }

    // Decrement ref counts for all referenced entities
    for (const refId of refIds) {
      if (refId !== 0) {
        await this.decrementRefCount(refId);
      }
    }
  }

  private async incrementRefCount(refId: number): Promise<void> {
    const delegate = this.delegate!;
    const refCountKey = refCountKeyFor(refId);
    const currentCount = (await delegate.getNumber(refCountKey)) ?? 0;
    const newCount = currentCount + 1;
    await delegate.setNumber(refCountKey, newCount);
  }

  private async decrementRefCount(refId: number): Promise<void> {
    const delegate = this.delegate!;
    const refCountKey = refCountKeyFor(refId);
    const currentCount = await delegate.getNumber(refCountKey);

    if (currentCount === undefined) {
      // Already deleted or never existed
      return;
    }

    const newCount = currentCount - 1;

    if (newCount === 0) {
      // Entity exists, cascade delete it
      await this.writerDeleteValue(refId);
    } else {
      await delegate.setNumber(refCountKey, newCount);
    }
  }
}
