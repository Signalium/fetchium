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
import { EntityInstance, isStaticFieldDef, type EntityKeys } from './EntityInstance.js';
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

/** Options for `new QueryClient(config)`. Every key also reaches queries and mutations as `this.context`. */
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
   * scope resumes) with data younger than this is not refetched, even if stale.
   * Subscription pushes count as fresh data. Queries can override it with
   * `reactivationGraceMs`. Reconnects, `refetch()`, invalidation, `markStale()`
   * and a failed last fetch still refetch. Default: 0. `Infinity` never
   * refetches on reactivation.
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
   * Queries of an adapter that `coalescesRequests` are not spread. Values that
   * are not finite and positive count as 0. Default: 0.
   */
  reactivationStaggerMs?: number;
  /**
   * Foreground/background source. When set, `poll()` stops its timers while
   * the app is inactive and resumes them when it becomes active again. Values
   * without `isActive` and `subscribe` are ignored. Default: undefined.
   */
  activity?: ActivitySource;
  /**
   * Milliseconds. A `poll()` tick that is overdue on resume, or whose timer
   * fires over a second late, runs at a random point within this window
   * instead of immediately. Values that are not finite and positive count as
   * 0. Default: 0.
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

/**
 * How long a failed cold fetch's error waits for a render to claim it. A
 * time-sliced retry render can take far longer than a task. An unclaimed
 * error belongs to an abandoned tree, so a later mount retries.
 */
const UNCLAIMED_FAILURE_TTL = 1_000;

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
  /** Set first by `destroy()`. Gates store writes and new requests. */
  destroyed: boolean = false;
  /** Without `store.onDelete`, `_persisted` cannot be trusted. */
  storeReportsDeletes: boolean = false;
  /** With `store.onPersisted`, `_persisted` is set on acknowledgement, not by `save()`. */
  storeAcksWrites: boolean = false;
  /** Replaced when a typename gains a class, since the static/dynamic split depends on it. */
  shapeKeyCache = new WeakMap<ValidatorDef<any>, EntityKeys>();

  readonly reactivationGraceMs: number;
  readonly reactivationStaggerMs: number;
  /** See `QueryClientConfig.shouldRetry`. */
  readonly shouldRetry: ShouldRetry | undefined;

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
  /** Keys whose last cold failure expired unclaimed. The next one waits `SUSPENSE_HOLD_TTL` for a slow reader. */
  private unclaimedFailures = new Set<number>();

  private context!: QueryContext;
  private typenameRegistry = new Map<string, ValidatorDef<any>[]>();
  private constraintRegistry = new Map<string, ConstraintMatcher>();
  private mergedDefCache = new Map<string, ValidatorDef<any>>();
  private adapters = new Map<QueryAdapterClass, QueryAdapter>();
  private networkUnsubscribe: (() => void) | undefined;
  private storeUnsubscribes: Array<() => void> = [];
  private mutationParseContext = new ParseContext();

  constructor(config: QueryClientConfig = {}) {
    const {
      store = new SyncQueryStore(new MemoryPersistentStore()),
      log,
      evictionMultiplier,
      adapters: _c,
      networkManager: _n,
      gcManager: _g,
      ...rest
    } = config as QueryClientConfig & Record<string, unknown>;
    this.isServer = typeof window === 'undefined';
    this.store = store;
    const { reactivationGraceMs, reactivationStaggerMs, shouldRetry } = config;
    this.reactivationGraceMs = nonNegative(reactivationGraceMs);
    // Must be finite: the window is split into setTimeout delays.
    this.reactivationStaggerMs = Number.isFinite(reactivationStaggerMs) ? nonNegative(reactivationStaggerMs) : 0;
    this.shouldRetry = typeof shouldRetry === 'function' ? shouldRetry : undefined;
    // The rest, including `activity` and `pollResumeJitterMs` for poll(), go to the context.
    this.context = { ...(rest as Record<string, unknown>), log: log ?? console, evictionMultiplier };
    this.gcManager =
      config.gcManager ??
      (this.isServer ? new NoOpGcManager() : new GcManager(this.handleEviction, evictionMultiplier));
    this.networkManager = config.networkManager ?? new NetworkManager();
    this.entityMap = new EntityStore((key, data, refs, merge, ifStored, rest, ownedKeys) => {
      if (this.destroyed) return;
      if (merge) this.store.mergeEntity!(key, data, refs, ifStored);
      else if (ownedKeys !== undefined) this.store.saveEntity(key, data, refs, undefined, ownedKeys);
      else if (rest !== undefined) this.store.saveEntity(key, data, refs, rest);
      else this.store.saveEntity(key, data, refs);
    });
    this.entityMap.mergesEntities = typeof this.store.mergeEntity === 'function';
    if (typeof this.store.readEntity === 'function') {
      const store = this.store;
      this.entityMap.readEntity = key => store.readEntity!(key);
    }
    // A record the store drops must be written again by the next apply.
    this.storeReportsDeletes = typeof this.store.onDelete === 'function';
    this.storeKnowsTypenameFields =
      typeof this.store.getEntityFieldNames === 'function' && this.store.entityFieldNamesComplete?.() === true;
    const offDelete = this.store.onDelete?.(key => {
      const instance = this.entityMap.getEntity(key);
      if (instance === undefined) return;
      // Failed writes are reported too. A surviving record keeps its fields.
      if (this.store.hasEntity?.(key) === true) instance.recordDropped();
      else instance.recordDeleted();
    });
    if (typeof offDelete === 'function') this.storeUnsubscribes.push(offDelete);
    this.storeAcksWrites = typeof this.store.onPersisted === 'function';
    const offPersisted = this.store.onPersisted?.(key => {
      this.entityMap.getEntity(key)?.acknowledgeWrite();
    });
    if (typeof offPersisted === 'function') this.storeUnsubscribes.push(offPersisted);

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

    if (this.destroyed) throw new Error(`QueryClient was destroyed. No adapter for ${adapterClass.name}.`);
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

  /** No queued store deletion can undo a skipped write. */
  storeIsSettled(): boolean {
    const store = this.store;
    if (store.hasQueuedDeletes !== undefined) return !store.hasQueuedDeletes();
    return store.isSettled?.() ?? true;
  }

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
      this.shapeKeyCache = new WeakMap();
    } else {
      this.typenameRegistry.set(typename, [def]);
    }
    this.noteTypenameFields(typename, def);
  }

  /** Per def: whether another class of its typename, in any session, declares a field it lacks. */
  private foreignFieldDefs = new WeakMap<ValidatorDef<any>, boolean>();
  private typenameFields = new Map<string, Set<string>>();
  private foreignRefFieldsByDef = new WeakMap<ValidatorDef<any>, readonly string[]>();
  hasForeignFieldDefs: boolean = false;
  /** The store's remembered field names cover every class that wrote a record it holds. */
  readonly storeKnowsTypenameFields: boolean;

  /**
   * Whether a stored record of this def's typename may hold fields the def
   * lacks. Registers the def first: a hydration parse can run before the apply
   * does. @internal
   */
  mayMissForeignFields(def: ValidatorDef<any>): boolean {
    let verdict = this.foreignFieldDefs.get(def);
    if (verdict === undefined) {
      this.registerEntityDef(def);
      verdict = this.foreignFieldDefs.get(def);
      if (verdict === undefined) {
        // A typename's merged def. A new class replaces it, so this can't go stale.
        const fields = def.typenameValue !== undefined ? this.typenameFields.get(def.typenameValue) : undefined;
        const shape = def.shape as Record<string, unknown> | undefined;
        verdict = fields !== undefined && shape !== undefined && fields.size > Object.keys(shape).length;
        this.foreignFieldDefs.set(def, verdict);
      }
    }
    return verdict;
  }

  /** Entity-holding fields other classes of the typename declare and this def lacks. @internal */
  foreignRefFields(def: ValidatorDef<any>): readonly string[] {
    let names = this.foreignRefFieldsByDef.get(def);
    if (names === undefined) {
      const found: string[] = [];
      const shape = def.shape as Record<string, unknown> | undefined;
      const defs = def.typenameValue !== undefined ? this.typenameRegistry.get(def.typenameValue) : undefined;
      if (shape !== undefined && defs !== undefined) {
        for (const d of defs) {
          if (d === def) continue;
          const other = d.shape as Record<string, unknown>;
          for (const f of Object.keys(other)) {
            if (!(f in shape) && !found.includes(f) && !isStaticFieldDef(other[f])) found.push(f);
          }
        }
      }
      this.foreignRefFieldsByDef.set(def, (names = found));
    }
    return names;
  }

  private noteTypenameFields(typename: string, def: ValidatorDef<any>): void {
    let fields = this.typenameFields.get(typename);
    if (fields === undefined) {
      fields = new Set(this.store.getEntityFieldNames?.(typename));
      this.typenameFields.set(typename, fields);
    }
    const declared = Object.keys(def.shape as Record<string, unknown>);
    let added: boolean = false;
    for (const k of declared) {
      if (!fields.has(k)) {
        fields.add(k);
        added = true;
      }
    }
    // All names, not just new ones: the store forgets names undeclared for a while.
    this.store.addEntityFieldNames?.(typename, declared);
    for (const d of this.typenameRegistry.get(typename)!) {
      // A known name may now have an entity-holding def.
      this.foreignRefFieldsByDef.delete(d);
      if (!added && d !== def) continue;
      const misses = fields.size > Object.keys(d.shape as Record<string, unknown>).length;
      this.foreignFieldDefs.set(d, misses);
      if (misses) this.hasForeignFieldDefs = true;
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
    if (this.destroyed) return;
    const refKeys =
      entityRefs !== undefined && entityRefs.size > 0
        ? new Set<number>([...entityRefs.keys()].map(e => e.key))
        : undefined;
    this.store.saveQuery(queryDef as any, queryKey, data, updatedAt, refKeys);
  }

  activateQuery(queryInstance: QueryInstance<any>): void {
    if (this.destroyed) return;
    const { def, queryKey, storageKey, config } = queryInstance;
    this.store.activateQuery(def as any, storageKey);

    const gcTime = config?.gcTime ?? DEFAULT_GC_TIME;
    this.gcManager.cancel(queryKey, gcTime);
  }

  deleteQuery(queryKey: number): void {
    if (!this.destroyed) this.store.deleteQuery(queryKey);
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
   * For `useSuspenseQuery`. Returns a promise to suspend on when the query has
   * never produced a value (a cold miss), or `undefined` when it has one to
   * render (in memory, or hydrated now from a synchronous store).
   *
   * A cold miss takes a hold that keeps the query active while suspended,
   * since React discards a suspended render without subscribing. A failed
   * query refetches once per hold, and a second failure sets `error`.
   *
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
          this.unclaimedFailures.delete(key);
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
            this.unclaimedFailures.delete(key);
            this.expireSuspenseHold(key, current);
            resolve();
          },
          () => {
            current.done = true;
            // Dropped unless the retried render claims the error first.
            clearTimeout(current.timer);
            const ttl = this.unclaimedFailures.has(key) ? SUSPENSE_HOLD_TTL : UNCLAIMED_FAILURE_TTL;
            current.timer = setTimeout(() => {
              if (this.suspenseHolds.get(key) !== current || current.failed) return;
              this.unclaimedFailures.add(key);
              this.releaseSuspenseHold(key);
            }, ttl);
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
   * `copyInput: false` copies a nested object only where a parsed value differs.
   */
  parseData(
    obj: unknown,
    shape: InternalTypeDef,
    preloadedEntities?: PreloadedEntityMap,
    copyInput: boolean = true,
  ): ParseResult {
    const warn = this.context.log?.warn ?? (() => {});
    const ctx = new ParseContext();
    ctx.reset(this, preloadedEntities, warn);
    ctx.copyInput = copyInput;
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
      // On a copy: the payload belongs to the adapter (it may be frozen).
      obj = { ...(obj as Record<string | symbol, unknown>), [QUERY_ID]: queryId };
    }

    const parseResult = this.parseData(obj, rootEntityShape as unknown as InternalTypeDef, preloadedEntities, false);
    const result = applyEntityRefs(parseResult.ctx, parseResult.data, persist, appendMode);

    // Discover the root entity from the returned proxy
    const proxyKey = PROXY_ID.get(result.data as object);
    return this.entityMap.getEntity(proxyKey!)!;
  }

  prepareEntity(
    key: number,
    obj: Record<string, unknown>,
    shape: EntityDef,
    existing?: EntityInstance,
  ): EntityInstance {
    this.registerEntityDef(shape as unknown as ValidatorDef<any>);
    if (existing !== undefined) {
      existing.parseId = this.currentParseId;
      return existing;
    }
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

    // Entities the event creates are written only once something retains them.
    const created = existing === undefined ? new Set<EntityInstance>() : undefined;
    try {
      const warn = this.context.log?.warn ?? (() => {});
      const parseCtx = this.mutationParseContext;
      parseCtx.reset(this, undefined, warn, /* isPartialEvent */ true);
      const parsedData = parseEntity(data, mergedDef as unknown as EntityDef, parseCtx);
      applyEntityRefs(parseCtx, parsedData, existing !== undefined ? true : 'existing', false, created);
    } catch (e) {
      // Unknown required-union variant: surface as an error (not a silent warn)
      // so the dropped update is visible. Optional unions degrade during parse.
      if (e instanceof UnknownUnionVariantError) {
        this.context.log?.error?.('Mutation event dropped: unknown union variant; update not applied', e);
      } else {
        this.context.log?.warn?.('Failed to apply mutation event', e);
      }
      if (existing === undefined) {
        const createdRoot = this.entityMap.getEntity(key);
        if (createdRoot !== undefined) this.evictCreated(createdRoot, created!);
      }
      return;
    }

    const entity = this.entityMap.getEntity(key);
    if (entity === undefined) return;

    if (existing !== undefined) {
      this.routeEvent(typename, entity.data, key, type, eventSource);
      return;
    }

    // Write a created root if a live array will retain it, else only refresh a
    // record the store may hold. Before routing, so a failed write routes nothing.
    let matched = false;
    let retains = false;
    this.routeEvent(
      typename,
      entity.data,
      key,
      type,
      eventSource,
      willRetain => {
        matched = true;
        if (willRetain) retains = true;
      },
      undefined,
      /* dryRun */ true,
    );
    let held: boolean | undefined;
    if (!entity._persisted && entity._pendingWrites === 0) {
      if (!retains) held = this.store.hasEntity?.(key);
      // Unknown: entities created under the root would be written even if the root isn't.
      const refresh =
        held === true ||
        (held === undefined && entity._partial && created!.size === 1 && this.entityMap.mergesEntities);
      if (retains || refresh) {
        try {
          entity.save(held, !retains);
        } catch (e) {
          this.context.log?.warn?.('Failed to apply mutation event', e);
          this.evictUnlessAdopted(entity, created!);
          return;
        }
      }
    }

    if (matched) this.routeEvent(typename, entity.data, key, type, eventSource);
    else this.evictUnlessAdopted(entity, created!);
  }

  /** References from entities the same event created don't count as adoption. */
  private evictUnlessAdopted(root: EntityInstance, created: Set<EntityInstance>): void {
    let createdHolders = 0;
    for (const c of created) if (c.entityRefs?.has(root)) createdHolders++;
    if (root.refCount <= createdHolders) this.evictCreated(root, created);
  }

  /** Also evicts unreferenced entities the event created, so a later event can't write them as orphans. */
  private evictCreated(root: EntityInstance, created: Set<EntityInstance>): void {
    root.evict();
    let evicted = true;
    while (evicted) {
      evicted = false;
      for (const c of created) {
        if (c !== root && c.refCount === 0 && this.entityMap.getEntity(c.key) === c) {
          c.evict();
          evicted = true;
        }
      }
    }
  }

  private deferredWrites: Set<EntityInstance> | undefined;

  /** @internal */
  deferWrite(entity: EntityInstance): void {
    (this.deferredWrites ??= new Set()).add(entity);
  }

  /** Children were deferred before parents, so insertion order is write order. */
  /** @internal */
  flushDeferredWrites(): void {
    const deferred = this.deferredWrites;
    if (deferred === undefined || deferred.size === 0) return;
    this.deferredWrites = undefined;
    try {
      for (const entity of deferred) {
        if (entity._applying || this.entityMap.getEntity(entity.key) !== entity) continue;
        if (entity._deferredWrite || (!entity._persisted && entity._pendingWrites === 0)) entity.save();
      }
    } finally {
      for (const entity of deferred) {
        if (entity._deferredWrite) {
          entity._deferredWrite = false;
          entity.markUnwritten();
        }
      }
    }
  }

  /** @internal */
  discardDeferredWrites(): void {
    const deferred = this.deferredWrites;
    if (deferred === undefined) return;
    this.deferredWrites = undefined;
    for (const entity of deferred) {
      if (entity._deferredWrite) {
        entity._deferredWrite = false;
        entity.markUnwritten();
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

  /**
   * Evicts `owner`'s old non-entity root unless another instance still shows it.
   * @internal
   */
  releaseQueryRoot(root: EntityInstance, owner: QueryInstance<any>): void {
    if (this.entityMap.getEntity(root.key) !== root) return;
    for (const instance of this.queryInstances.values()) {
      if (instance !== owner && instance.rootEntity === root) return;
    }
    root.evict();
  }

  private handleEviction = (key: number, type: GcKeyType): void => {
    if (type === GcKeyType.Query) {
      const instance = this.queryInstances.get(key);
      if (instance === undefined) return;
      // Nothing may settle its relay or reach the store after this.
      instance.abortForDestroy();
      const root = instance.rootEntity;
      if (root !== undefined) {
        if (instance.def.statics.isEntityResult) root.evict();
        else this.releaseQueryRoot(root, instance);
      }
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
    onMatch?: (willRetain: boolean) => void,
    deleteData?: Record<string, unknown>,
    dryRun: boolean = false,
  ): void {
    const matcher = this.constraintRegistry.get(typename);
    if (matcher === undefined) return;

    const data = eventSource !== undefined ? { ...entityData, [EVENT_SOURCE_FIELD]: eventSource } : entityData;
    matcher.routeEvent(typename, data, entityKey, eventType, onMatch, deleteData, dryRun);
  }

  destroy(): void {
    this.destroyed = true;
    for (const key of [...this.suspenseHolds.keys()]) this.releaseSuspenseHold(key);
    this.unclaimedFailures.clear();
    for (const release of [...this.leases]) release();
    clearTimeout(this.staggerTimer);
    this.staggerTimer = undefined;
    this.staggerQueue.clear();
    this.networkUnsubscribe?.();
    for (const off of this.storeUnsubscribes) off();
    this.storeUnsubscribes = [];
    this.gcManager.destroy();
    this.networkManager.destroy();
    for (const adapter of this.adapters.values()) {
      adapter.destroy?.();
    }
    this.adapters.clear();
    for (const instance of this.queryInstances.values()) instance.abortForDestroy();
    this.queryInstances.clear();
    this.mutationInstances.clear();
    this.entityMap.clear();
    this.constraintRegistry.clear();
    this.typenameRegistry.clear();
    this.typenameFields.clear();
    this.foreignFieldDefs = new WeakMap();
    this.foreignRefFieldsByDef = new WeakMap();
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
