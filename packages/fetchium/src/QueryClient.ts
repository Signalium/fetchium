import { context, signal, watcher, withContexts, ReactivePromise, ReactiveTask, type Context } from 'signalium';
import { hashValue } from 'signalium/utils';
import {
  EntityDef,
  MutationEvent,
  QueryPromise,
  ComplexTypeDef,
  InternalTypeDef,
  QUERY_ID,
  InvalidateTarget,
} from './types.js';
import { PROXY_ID } from './proxyId.js';
import { EntityStore } from './EntityStore.js';
import { EntityInstance } from './EntityInstance.js';
import { NetworkManager, NoOpNetworkManager } from './NetworkManager.js';
import { QueryInstance } from './QueryResult.js';
import { MutationResultImpl } from './MutationResult.js';
import { MutationDefinition } from './mutation.js';
import { GcManager, NoOpGcManager, GcKeyType } from './GcManager.js';
import { DEFAULT_GC_TIME } from './stores/shared.js';
import { Query, QueryDefinition } from './query.js';
import { ParseContext, parseEntities, parseEntity, type ParseResult } from './parseEntities.js';
import { UnknownUnionVariantError } from './errors.js';
import { applyEntityRefs, type ApplyResult } from './applyEntities.js';
import { ValidatorDef } from './typeDefs.js';
import { ConstraintMatcher, EVENT_SOURCE_FIELD } from './ConstraintMatcher.js';
import { LiveCollectionBinding } from './LiveCollection.js';
import { QueryAdapter, type QueryAdapterClass } from './QueryAdapter.js';
import type { ShouldRetry } from './retry.js';
import {
  type QueryContext,
  type QueryStore,
  type QueryParams,
  type PreloadedEntityMap,
  type ActivitySource,
  queryKeyFor,
} from './query-types.js';
import { SyncQueryStore, MemoryPersistentStore } from './stores/sync.js';
import type { ExtractType } from './types.js';
import type { Optionalize, Signalize } from './type-utils.js';

export interface QueryClientConfig {
  store?: QueryStore;
  adapters?: QueryAdapter[];
  networkManager?: NetworkManager | NoOpNetworkManager;
  gcManager?: GcManager | NoOpGcManager;
  log?: {
    error?: (message: string, error?: unknown) => void;
    warn?: (message: string, error?: unknown) => void;
    info?: (message: string) => void;
    debug?: (message: string) => void;
  };
  evictionMultiplier?: number;
  /**
   * Milliseconds. A query that reactivates (a watcher returns, or a paused
   * scope resumes) with data younger than this is not refetched, even if past
   * its `staleTime`. Data a subscription pushed to (a `subscribe` event, or a
   * topic event sent with its topic) counts as fresh from the last push. A
   * `poll()` counts only through its fetches. Queries can override this with
   * `reactivationGraceMs`. Network reconnects, `refetch()`,
   * `invalidateQueries()`, `markStale()` and a failed last fetch still
   * refetch. Default: 0 (every stale query refetches on reactivation).
   */
  reactivationGraceMs?: number;
  /**
   * Decides whether a failed query or mutation attempt is retried, for example
   * to stop on a 4xx. A query's or mutation's own `retry.shouldRetry` overrides
   * it. Default: every failed attempt is retried.
   */
  shouldRetry?: ShouldRetry;
  /**
   * Milliseconds. Reactivation refetches that start in the same task (for
   * example every query on a screen that just resumed) are spread evenly
   * across this window, in activation order, instead of all starting at once.
   * Queries of an adapter that `coalescesRequests` are not spread. Default: 0
   * (all start together).
   */
  reactivationStaggerMs?: number;
  /**
   * Foreground/background source. When set, `poll()` stops its timers while
   * the app is inactive and resumes them when it becomes active again.
   * Default: undefined (polls run regardless of app state).
   */
  activity?: ActivitySource;
  /**
   * Milliseconds. A `poll()` tick that is overdue when the app becomes active,
   * or whose timer fires over a second late (as after the JS thread was
   * suspended), fires at a random point within this window instead of
   * immediately alongside every other overdue poll. Default: 0.
   */
  pollResumeJitterMs?: number;
}

export interface RetainOptions {
  /** Milliseconds until the lease releases itself. Omit to hold until `release` is called. */
  ttl?: number;
}

export interface PrefetchOptions {
  /** Milliseconds to keep the query active. Default: `DEFAULT_PREFETCH_TTL` (10 s). */
  ttl?: number;
}

export const DEFAULT_PREFETCH_TTL = 10_000;

/** How long a hold outlives its fetch when no reader commits (abandoned tree). */
const SUSPENSE_HOLD_TTL = 10_000;

/** React retries a suspended render within a task or two. An error unclaimed by then is dropped. */
const UNCLAIMED_FAILURE_TTL = 50;

interface SuspenseHold {
  release: () => void;
  /** Never rejects. */
  settled: Promise<void> | undefined;
  done: boolean;
  /** The error has been handed to a render. */
  failed: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export {
  type QueryContext,
  type ActivitySource,
  type QueryCacheOptions,
  type QueryConfigOptions,
  type FetchNextConfig,
  type QueryParams,
  type QueryStore,
  type CachedQuery,
  type PreloadedEntityMap,
  type MaybePromise,
  resolveBaseUrl,
  extractParamsForKey,
  queryKeyFor,
} from './query-types.js';

export class QueryClient {
  entityMap: EntityStore;
  queryInstances = new Map<number, QueryInstance<any>>();
  mutationInstances = new Map<string, MutationResultImpl<unknown, unknown>>();
  gcManager: GcManager | NoOpGcManager;
  networkManager: NetworkManager | NoOpNetworkManager;
  isServer: boolean;
  store: QueryStore;

  currentParseId: number = 0;
  /** Without `store.onDelete`, `_persisted` cannot be trusted. */
  storeReportsDeletes: boolean = false;

  /** See `QueryClientConfig.reactivationGraceMs`. */
  readonly reactivationGraceMs: number;
  /** See `QueryClientConfig.reactivationStaggerMs`. */
  readonly reactivationStaggerMs: number;
  /** See `QueryClientConfig.shouldRetry`. */
  readonly shouldRetry: ShouldRetry | undefined;

  /** Queries whose reactivation refetch waits for the current task's stagger flush. */
  private staggerQueue = new Set<QueryInstance<any>>();
  private staggerTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  private leases = new Set<() => void>();
  /** During a lease's first run: queries with a start queued on a microtask, for the lease to run now. */
  private leaseStarts: Set<QueryInstance<any>> | undefined = undefined;
  /** Leases `retain()` took inside a reactive computation, by computation and run. */
  private reactiveLeases = new WeakMap<object, { run: number; releases: Array<() => void> }>();
  private warnedReactiveRetain = false;
  /** `useSuspenseQuery` cold-miss leases, by query key. */
  private suspenseHolds = new Map<number, SuspenseHold>();

  private context!: QueryContext;
  private typenameRegistry = new Map<string, ValidatorDef<any>[]>();
  private constraintRegistry = new Map<string, ConstraintMatcher>();
  private mergedDefCache = new Map<string, ValidatorDef<any>>();
  private adapters = new Map<QueryAdapterClass, QueryAdapter>();
  private networkUnsubscribe: (() => void) | undefined;
  private mutationParseContext = new ParseContext();

  constructor(config: QueryClientConfig = {}) {
    const {
      store = new SyncQueryStore(new MemoryPersistentStore()),
      log,
      evictionMultiplier,
      reactivationGraceMs,
      reactivationStaggerMs,
      shouldRetry,
      adapters: _c,
      networkManager: _n,
      gcManager: _g,
      ...rest
    } = config as QueryClientConfig & Record<string, unknown>;
    this.isServer = typeof window === 'undefined';
    this.store = store;
    this.reactivationGraceMs = nonNegative(reactivationGraceMs);
    this.reactivationStaggerMs = nonNegative(reactivationStaggerMs);
    this.shouldRetry = shouldRetry;
    // `activity` and `pollResumeJitterMs` ride along in `rest`: poll() reads them from the context.
    this.context = { ...rest, log: log ?? console, evictionMultiplier };
    this.gcManager =
      config.gcManager ??
      (this.isServer ? new NoOpGcManager() : new GcManager(this.handleEviction, evictionMultiplier));
    this.networkManager = config.networkManager ?? new NetworkManager();
    this.entityMap = new EntityStore((key, data, refs) => this.store.saveEntity(key, data, refs));
    // A record the store drops must be written again by the next apply.
    this.storeReportsDeletes = typeof this.store.onDelete === 'function';
    this.store.onDelete?.(key => {
      const entity = this.entityMap.getEntity(key);
      if (entity !== undefined) entity._persisted = false;
    });

    // Register user-supplied adapters
    for (const adapter of config.adapters ?? []) {
      this.adapters.set(adapter.constructor as QueryAdapterClass, adapter);
      adapter.register(this);
    }

    // Notify adapters when network status changes
    const onlineSignal = this.networkManager.getOnlineSignal();
    const networkWatcher = watcher(() => onlineSignal.value);
    this.networkUnsubscribe = networkWatcher.addListener(
      () => {
        const isOnline = onlineSignal.value;
        for (const adapter of this.adapters.values()) {
          adapter.onNetworkStatusChange?.(isOnline);
        }
      },
      { skipInitial: true },
    );

    this.store.purgeStaleQueries?.();
  }

  /**
   * Returns the registered adapter instance for the given adapter class.
   *
   * Resolution order:
   * 1. Exact class match in the registered adapters.
   * 2. Subclass match — if any registered adapter is an `instanceof adapterClass`,
   *    return it. This lets queries declare an abstract base adapter (e.g.
   *    `TopicQueryAdapter`) and have the consumer-supplied concrete subclass
   *    (e.g. a `WebSocket`-backed adapter) resolve to it.
   * 3. Auto-instantiate via the no-arg constructor (for adapters like
   *    `RESTQueryAdapter` that default to `globalThis.fetch`).
   *
   * In dev builds, step 2 verifies that at most one registered adapter
   * matches the lookup and throws otherwise. The dev-only check is stripped
   * from production builds.
   *
   * Throws if none of those succeed.
   */
  getAdapter(adapterClass: QueryAdapterClass): QueryAdapter {
    const exact = this.adapters.get(adapterClass);
    if (exact) return exact;

    let match: QueryAdapter | undefined;
    for (const registered of this.adapters.values()) {
      if (registered instanceof adapterClass) {
        if (IS_DEV && match !== undefined) {
          throw new Error(
            `Adapter lookup for ${adapterClass.name} matches multiple registered adapters: ` +
              `${match.constructor.name} and ${registered.constructor.name}. ` +
              `Register only one adapter per lookup base on a single QueryClient, ` +
              `or split into separate QueryClients.`,
          );
        }
        match ??= registered;
      }
    }
    if (match !== undefined) {
      this.adapters.set(adapterClass, match);
      return match;
    }

    let adapter: QueryAdapter;
    try {
      adapter = new (adapterClass as new () => QueryAdapter)();
    } catch {
      throw new Error(
        `No adapter registered for ${adapterClass.name} and auto-instantiation failed. ` +
          `Pass an instance via QueryClient config: new QueryClient({ store, adapters: [new ${adapterClass.name}(...)] })`,
      );
    }
    this.adapters.set(adapterClass, adapter);
    adapter.register(this);
    return adapter;
  }

  getContext(): QueryContext {
    return this.context;
  }

  // ======================================================
  // Typename Registry (per-client)
  // ======================================================

  private registerEntityDef(def: ValidatorDef<any>): void {
    const typename = def.typenameValue;
    if (typename === undefined) return;
    if (def._entityClass === undefined) return;

    const existing = this.typenameRegistry.get(typename);

    if (existing !== undefined) {
      if (existing.indexOf(def) !== -1) return;

      existing.push(def);
      this.mergedDefCache.delete(typename);
      this.getMergedDef(typename);
    } else {
      this.typenameRegistry.set(typename, [def]);
    }
  }

  getEntityDefsForTypename(typename: string): ValidatorDef<any>[] | undefined {
    return this.typenameRegistry.get(typename);
  }

  getMergedDef(typename: string): ValidatorDef<any> | undefined {
    let merged = this.mergedDefCache.get(typename);
    if (merged !== undefined) return merged;

    const defs = this.typenameRegistry.get(typename);
    if (defs === undefined) return undefined;

    merged = ValidatorDef.merge(defs);
    this.mergedDefCache.set(typename, merged);
    return merged;
  }

  saveQueryData(
    queryDef: QueryDefinition<QueryParams | undefined, unknown, unknown>,
    queryKey: number,
    data: unknown,
    updatedAt: number,
    entityRefs?: Map<EntityInstance, number>,
  ): void {
    const refKeys =
      entityRefs !== undefined && entityRefs.size > 0
        ? new Set<number>([...entityRefs.keys()].map(e => e.key))
        : undefined;
    this.store.saveQuery(queryDef as any, queryKey, data, updatedAt, refKeys);
  }

  activateQuery(queryInstance: QueryInstance<any>): void {
    const { def, queryKey, storageKey, config } = queryInstance;
    this.store.activateQuery(def as any, storageKey);

    const gcTime = config?.gcTime ?? DEFAULT_GC_TIME;
    this.gcManager.cancel(queryKey, gcTime);
  }

  loadCachedQuery(queryDef: QueryDefinition<QueryParams | undefined, unknown, unknown>, queryKey: number) {
    return this.store.loadQuery(queryDef as any, queryKey);
  }

  /**
   * Loads a query from the document store and returns a QueryResult
   * that triggers fetches and prepopulates with cached data
   */
  getQuery<T extends Query>(
    queryDef: QueryDefinition<any, any, any>,
    params: QueryParams | undefined,
  ): QueryPromise<T> {
    const queryKey = queryKeyFor(queryDef, params);

    let queryInstance = this.queryInstances.get(queryKey) as QueryInstance<T> | undefined;

    // Create a new instance if it doesn't exist
    if (queryInstance === undefined) {
      queryInstance = new QueryInstance(queryDef, this, queryKey, params);

      // Store for future use
      this.queryInstances.set(queryKey, queryInstance as QueryInstance<any>);
    }

    // An earlier reader may have activated it with its start still queued.
    this.leaseStarts?.add(queryInstance);

    return queryInstance.relay;
  }

  // ======================================================
  // Leases (retain / prefetch)
  // ======================================================

  /**
   * Keeps the queries `fn` reads or returns active (fetched, subscribed, exempt
   * from GC) until `release` is called or `ttl` elapses. `fn` reruns when what
   * it reads changes. First-run fetches start before `retain` returns. Call it
   * from an event handler or effect, not a reactive computation.
   *
   * ```ts
   * const release = client.retain(() => [fetchQuery(GetTokens), fetchQuery(GetPrices, { ids })]);
   * release();
   * ```
   */
  retain(fn: () => unknown, options?: RetainOptions): () => void {
    const owner = currentReactiveOwner();
    if (owner === undefined) return this.lease(fn, options, true);

    if (IS_DEV && !this.warnedReactiveRetain) {
      this.warnedReactiveRetain = true;
      this.context.log?.warn?.(
        'QueryClient.retain() (or prefetch()) was called inside a reactive computation. Call it from an event handler or effect instead.',
      );
    }

    const release = this.lease(fn, options, false);
    const previous = this.reactiveLeases.get(owner.ref);
    if (previous === undefined || previous.run !== owner.run) {
      this.reactiveLeases.set(owner.ref, { run: owner.run, releases: [release] });
      // After taking the new lease, so queries both runs read stay active.
      if (previous !== undefined) for (const prior of previous.releases) prior();
    } else {
      previous.releases.push(release);
    }
    return release;
  }

  /** `startNow: false` leaves first-run fetches on their microtask, for callers inside a render. */
  private lease(fn: () => unknown, options: RetainOptions | undefined, startNow: boolean): () => void {
    const w = withContexts([[QueryClientContext, this]], () => watcher(() => holdReturned(fn())));
    const unsubscribe = w.addListener(noop);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let released = false;

    const release = (): void => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      this.leases.delete(release);
      unsubscribe();
    };

    this.leases.add(release);

    const outerStarts = this.leaseStarts;
    const starts = startNow ? new Set<QueryInstance<any>>() : undefined;
    this.leaseStarts = starts;
    try {
      // Activate now, not on Signalium's next flush.
      void w.value;
    } catch (error) {
      release();
      throw error;
    } finally {
      this.leaseStarts = outerStarts;
    }

    // Outside the watcher's computation now, so adapter code may run.
    if (starts !== undefined) {
      try {
        for (const instance of starts) instance.startPendingNow();
      } catch (error) {
        release();
        throw error;
      }
    }

    const ttl = options?.ttl;
    if (ttl !== undefined && Number.isFinite(ttl)) {
      timer = setTimeout(release, Math.max(0, ttl));
    }

    return release;
  }

  /**
   * Starts `QueryClass` now and keeps it active for `ttl` ms (default
   * {@link DEFAULT_PREFETCH_TTL}) or until `release` is called, so a reader
   * mounting within that window reuses the fetch. The lease ends at `ttl` even
   * if the fetch is in flight, which aborts it unless a reader has joined.
   */
  prefetch<T extends Query>(
    QueryClass: new () => T,
    params?: Optionalize<Signalize<ExtractType<T['params']>>>,
    options?: PrefetchOptions,
  ): () => void {
    const def = QueryDefinition.for(QueryClass);
    return this.retain(() => this.getQuery(def, params as QueryParams | undefined), {
      ttl: options?.ttl ?? DEFAULT_PREFETCH_TTL,
    });
  }

  /**
   * On a cold miss, returns a promise to suspend on and holds the query active
   * until the reader commits. A failed cold fetch returns `error` instead.
   * @internal
   */
  suspendOnColdMiss(
    def: QueryDefinition<any, any, any>,
    params: QueryParams | undefined,
  ): { promise: Promise<void> | undefined; failed?: true; error?: unknown; key: number } {
    const key = queryKeyFor(def, params);
    const relay = this.getQuery(def, params);
    if (relay.isReady) return { promise: undefined, key };

    let hold = this.suspenseHolds.get(key);
    if (hold === undefined) {
      const release = this.lease(() => this.getQuery(def, params), undefined, false);
      hold = { release, settled: undefined, done: false, failed: false, timer: undefined };
      this.suspenseHolds.set(key, hold);
    }

    if (relay.isReady) {
      // Hydrated by the activation. Keep the hold until the reader commits.
      this.expireSuspenseHold(key, hold);
      return { promise: undefined, key };
    }

    if (relay.isPending && hold.done) {
      // Another fetch started after ours settled. Rethrowing the resolved
      // promise would re-render at once.
      clearTimeout(hold.timer);
      hold.timer = undefined;
      hold.done = false;
      hold.failed = false;
      hold.settled = undefined;
    }

    if (!relay.isPending) {
      if (hold.done) {
        // Keep the hold one task: React re-renders a throwing component once
        // more, and that render must throw the same error, not refetch.
        const error = relay.error;
        if (!hold.failed) {
          hold.failed = true;
          clearTimeout(hold.timer);
          hold.timer = setTimeout(() => {
            if (this.suspenseHolds.get(key) === hold) this.releaseSuspenseHold(key);
          }, 0);
        }
        return { promise: undefined, failed: true, error, key };
      }
      // Start now, not after the activation's refetch hop.
      this.queryInstances.get(key)?.refetch();
    }

    if (hold.settled === undefined) {
      const current = hold;
      current.settled = new Promise<void>(resolve => {
        relay.then(
          () => {
            current.done = true;
            this.expireSuspenseHold(key, current);
            resolve();
          },
          () => {
            current.done = true;
            // Dropped unless the retried render claims the error first.
            clearTimeout(current.timer);
            current.timer = setTimeout(() => {
              if (this.suspenseHolds.get(key) === current && !current.failed) this.releaseSuspenseHold(key);
            }, UNCLAIMED_FAILURE_TTL);
            resolve();
          },
        );
      });
    }

    return { promise: hold.settled, key };
  }

  /** Releases a `useSuspenseQuery` hold once its reader has committed. @internal */
  releaseSuspenseHold(key: number): void {
    const hold = this.suspenseHolds.get(key);
    if (hold === undefined) return;
    this.suspenseHolds.delete(key);
    clearTimeout(hold.timer);
    hold.release();
  }

  private expireSuspenseHold(key: number, hold: SuspenseHold): void {
    if (hold.timer !== undefined || this.suspenseHolds.get(key) !== hold) return;
    hold.timer = setTimeout(() => {
      if (this.suspenseHolds.get(key) === hold) this.releaseSuspenseHold(key);
    }, SUSPENSE_HOLD_TTL);
  }

  /**
   * Gets or creates a MutationResult for the given mutation definition.
   * Mutations are cached by their definition ID.
   */
  getMutation<Request, Response>(
    mutationDef: MutationDefinition<Request, Response>,
  ): ReactiveTask<Response, [Request]> {
    const mutationId = mutationDef.id;

    let mutationInstance = this.mutationInstances.get(mutationId) as MutationResultImpl<Request, Response> | undefined;

    // Create a new instance if it doesn't exist
    if (mutationInstance === undefined) {
      mutationInstance = new MutationResultImpl(mutationDef, this);

      // Store for future use
      this.mutationInstances.set(mutationId, mutationInstance as MutationResultImpl<unknown, unknown>);
    }

    return mutationInstance.task;
  }

  /**
   * Parse data: validates, formats, produces parsed entity data objects.
   * Does NOT touch the entity store. Call applyRefs() after to commit entities.
   */
  parseData(obj: unknown, shape: InternalTypeDef, preloadedEntities?: PreloadedEntityMap): ParseResult {
    const warn = this.context.log?.warn ?? (() => {});
    const ctx = new ParseContext();
    ctx.reset(this, preloadedEntities, warn);
    const data = parseEntities(obj, shape as unknown as ComplexTypeDef, ctx);
    return { data, ctx };
  }

  /**
   * Apply entities from parseData() via a single depth-first walk: creates/
   * updates EntityInstances, replaces parsed data with proxies, counts child
   * refs. Returns the reified data and root-level entity refs.
   */
  applyRefs(parseResult: ParseResult, persist: boolean = true, appendMode: boolean = false): ApplyResult {
    return applyEntityRefs(parseResult.ctx, parseResult.data, persist, appendMode);
  }

  /**
   * Parse and apply data as a root entity. For non-entity results, injects
   * QUERY_ID onto the payload. Returns the root EntityInstance (created or
   * found in the store by the standard entity pipeline).
   */
  parseAndApplyRootEntity(
    obj: unknown,
    queryId: number,
    rootEntityShape: ValidatorDef<any>,
    persist: boolean,
    appendMode: boolean = false,
    preloadedEntities?: PreloadedEntityMap,
  ): EntityInstance {
    // For non-entity results (QUERY_ID idField), inject the query id onto
    // fresh data payloads. Cached data arrives as { __entityRef } so
    // parseEntityData reads the key directly from that instead.
    if (
      typeof rootEntityShape.idField === 'symbol' &&
      typeof obj === 'object' &&
      obj !== null &&
      !('__entityRef' in (obj as Record<string, unknown>))
    ) {
      (obj as Record<string | symbol, unknown>)[QUERY_ID] = queryId;
    }

    const parseResult = this.parseData(obj, rootEntityShape as unknown as InternalTypeDef, preloadedEntities);
    const result = applyEntityRefs(parseResult.ctx, parseResult.data, persist, appendMode);

    // Discover the root entity from the returned proxy
    const proxyKey = PROXY_ID.get(result.data as object);
    return this.entityMap.getEntity(proxyKey!)!;
  }

  prepareEntity(key: number, obj: Record<string, unknown>, shape: EntityDef): EntityInstance {
    this.registerEntityDef(shape as unknown as ValidatorDef<any>);
    return this.entityMap.getOrCreateEntity(key, obj, shape, this);
  }

  // ======================================================
  // Mutation Events
  // ======================================================

  applyMutationEvent(event: MutationEvent): void {
    const { type, typename } = event;

    const mergedDef = this.getMergedDef(typename);
    if (mergedDef === undefined) return;

    const idField = mergedDef.idField;
    if (idField === undefined || typeof idField === 'symbol') return;

    const rawData = event.data;
    const id =
      event.id !== undefined
        ? event.id
        : type === 'delete' && (typeof rawData === 'string' || typeof rawData === 'number')
          ? rawData
          : (rawData as Record<string, unknown>)[idField];

    if (id === undefined) return;

    const key = hashValue([typename, id]);
    const eventSource = event.__eventSource;
    const data = (typeof rawData === 'object' && rawData !== null ? rawData : {}) as Record<string, unknown>;

    const existing = this.entityMap.getEntity(key);

    if (type === 'delete') {
      const entityData = existing !== undefined ? existing.data : data;
      this.routeEvent(typename, entityData, key, type, eventSource, undefined, entityData);
      return;
    }

    try {
      const warn = this.context.log?.warn ?? (() => {});
      const parseCtx = this.mutationParseContext;
      parseCtx.reset(this, undefined, warn, /* isPartialEvent */ true);
      const parsedData = parseEntity(data, mergedDef as unknown as EntityDef, parseCtx);
      // A new entity is written only once something routes it.
      applyEntityRefs(parseCtx, parsedData, /* persist */ existing !== undefined);
    } catch (e) {
      // Unknown required-union variant: surface as an error (not a silent warn)
      // so the dropped update is visible. Optional unions degrade during parse.
      if (e instanceof UnknownUnionVariantError) {
        this.context.log?.error?.('Mutation event dropped: unknown union variant; update not applied', e);
      } else {
        this.context.log?.warn?.('Failed to apply mutation event', e);
      }
      if (existing === undefined) {
        const created = this.entityMap.getEntity(key);
        if (created !== undefined) created.evict();
      }
      return;
    }

    const entity = this.entityMap.getEntity(key);
    if (entity === undefined) return;

    const wasNew = existing === undefined;
    let matched = false;

    this.routeEvent(typename, entity.data, key, type, eventSource, () => {
      matched = true;
    });

    if (wasNew) {
      if (matched) {
        // The parent persisted a ref to it, so its record must exist.
        persistUnwritten(entity);
      } else {
        entity.evict();
      }
    }
  }

  // ======================================================
  // Reactivation stagger
  // ======================================================

  /**
   * A query queued a start on a microtask. A lease in its first run starts it now.
   * @internal
   */
  noteDeferredStart(instance: QueryInstance<any>): void {
    this.leaseStarts?.add(instance);
  }

  /**
   * Queues a reactivation refetch. One flush per task spreads the queue evenly
   * across `reactivationStaggerMs` in reactivation order, the first starting
   * immediately. Queries of an adapter that `coalescesRequests` all start
   * immediately.
   */
  scheduleReactivationRefetch(instance: QueryInstance<any>): void {
    this.staggerQueue.add(instance);
    this.staggerTimer ??= setTimeout(this.flushStaggerQueue, 0);
  }

  private flushStaggerQueue = (): void => {
    this.staggerTimer = undefined;
    const spread: QueryInstance<any>[] = [];
    for (const instance of this.staggerQueue) {
      if (this.getAdapter(instance.def.statics.adapterClass).coalescesRequests === true) {
        instance.runReactivationRefetch(0);
      } else {
        spread.push(instance);
      }
    }
    this.staggerQueue.clear();
    const step = spread.length > 1 ? this.reactivationStaggerMs / spread.length : 0;
    for (let i = 0; i < spread.length; i++) {
      spread[i].runReactivationRefetch(Math.round(i * step));
    }
  };

  // ======================================================
  // Query Invalidation
  // ======================================================

  invalidateQueries(targets: ReadonlyArray<InvalidateTarget>): void {
    for (const target of targets) {
      const isArray = Array.isArray(target);
      const QueryClass = (isArray ? target[0] : target) as new () => Query;
      const paramSubset = isArray ? (target[1] as Record<string, unknown>) : undefined;

      const queryDef = QueryDefinition.for(QueryClass);
      const defId = queryDef.statics.id;

      for (const [, instance] of this.queryInstances) {
        if (instance.def.statics.id !== defId) continue;

        if (paramSubset === undefined || paramsMatch(instance.resolvedParams, paramSubset)) {
          instance.markStale();
        }
      }
    }
  }

  // ======================================================
  // In-Memory GC
  // ======================================================

  private handleEviction = (key: number, type: GcKeyType): void => {
    if (type === GcKeyType.Query) {
      const instance = this.queryInstances.get(key);
      if (instance === undefined) return;
      instance.stopSubscription();
      instance.rootEntity?.evict();
      this.queryInstances.delete(key);
      return;
    }
    const entity = this.entityMap.getEntity(key);
    if (entity !== undefined) entity.evict();
  };

  // ======================================================
  // Constraint Registry (Live Data)
  // ======================================================

  getOrCreateMatcher(typename: string): ConstraintMatcher {
    let matcher = this.constraintRegistry.get(typename);
    if (matcher === undefined) {
      matcher = new ConstraintMatcher();
      this.constraintRegistry.set(typename, matcher);
    }
    return matcher;
  }

  registerLiveCollection(binding: LiveCollectionBinding): void {
    for (const [typename, defs] of binding._entityDefsByTypename) {
      for (const def of defs) {
        this.registerEntityDef(def);
      }
      this.getOrCreateMatcher(typename).registerBinding(binding, typename);
    }
  }

  unregisterLiveCollection(binding: LiveCollectionBinding): void {
    for (const typename of binding._entityDefsByTypename.keys()) {
      const matcher = this.constraintRegistry.get(typename);
      if (matcher !== undefined) {
        matcher.unregisterBinding(binding, typename);
      }
    }
  }

  private routeEvent(
    typename: string,
    entityData: Record<string, unknown>,
    entityKey: number,
    eventType: 'create' | 'update' | 'delete',
    eventSource: number | undefined,
    onMatch?: () => void,
    deleteData?: Record<string, unknown>,
  ): void {
    const matcher = this.constraintRegistry.get(typename);
    if (matcher === undefined) return;

    const data = eventSource !== undefined ? { ...entityData, [EVENT_SOURCE_FIELD]: eventSource } : entityData;
    matcher.routeEvent(typename, data, entityKey, eventType, onMatch, deleteData);
  }

  destroy(): void {
    for (const key of [...this.suspenseHolds.keys()]) this.releaseSuspenseHold(key);
    for (const release of [...this.leases]) release();
    clearTimeout(this.staggerTimer);
    this.staggerTimer = undefined;
    this.staggerQueue.clear();
    this.networkUnsubscribe?.();
    this.gcManager.destroy();
    this.networkManager.destroy();
    for (const adapter of this.adapters.values()) {
      adapter.destroy?.();
    }
    this.adapters.clear();
    this.queryInstances.clear();
    this.mutationInstances.clear();
    this.entityMap.clear();
    this.constraintRegistry.clear();
    this.typenameRegistry.clear();
    this.mergedDefCache.clear();
  }
}

export const QueryClientContext: Context<QueryClient | undefined> = context<QueryClient | undefined>(undefined);

const noop = (): void => {};

/**
 * The running reactive computation and its run, if any. Signalium has no public
 * API for this, so read a throwaway signal and inspect the consumer it recorded.
 */
function currentReactiveOwner(): { ref: object; run: number } | undefined {
  try {
    const probe = signal(0);
    void probe.value;
    const subs = (probe as unknown as { _subs?: Map<object, number> })._subs;
    if (!(subs instanceof Map) || subs.size === 0) return undefined;
    const [ref, run] = subs.entries().next().value!;
    return typeof ref === 'object' && ref !== null && typeof run === 'number' ? { ref, run } : undefined;
  } catch {
    return undefined;
  }
}

/** Reads `isReady` on returned query promises so the lease's watcher keeps them active. */
function holdReturned(returned: unknown): void {
  if (Array.isArray(returned)) {
    for (const item of returned) holdOne(item);
  } else {
    holdOne(returned);
  }
}

function holdOne(value: unknown): void {
  if (value instanceof ReactivePromise) void value.isReady;
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && value > 0 ? value : 0;
}

function paramsMatch(instanceParams: Record<string, unknown> | undefined, subset: Record<string, unknown>): boolean {
  if (instanceParams === undefined) return false;
  for (const key in subset) {
    if (instanceParams[key] !== subset[key]) return false;
  }
  return true;
}

/** Writes an entity and its not-yet-written descendants. */
function persistUnwritten(entity: EntityInstance): void {
  if (!entity._persisted) entity.save();
  const refs = entity.entityRefs;
  if (refs === undefined) return;
  for (const child of refs.keys()) {
    if (!child._persisted) persistUnwritten(child);
  }
}
