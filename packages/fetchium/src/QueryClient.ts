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

/**
 * Options for `new QueryClient(config)`. Every key, including unlisted ones,
 * also reaches query and mutation code as `this.context`, so an app can pass
 * its own services through the config. The names declared below are reserved
 * and always read as that option.
 */
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
   * scope resumes) with data younger than this is not refetched, even when the
   * data is past its `staleTime`. Data a subscription pushed to (a `subscribe`
   * stream event, or a topic event sent with its topic) counts as fresh from
   * the last push; a `poll()` keeps data current only through the fetches it
   * makes. Queries can override the window with `reactivationGraceMs` in
   * their config. Network reconnects,
   * `refetch()`, `invalidateQueries()`, `markStale()` and a failed last fetch
   * still refetch. `Infinity` never refetches on reactivation. Default: 0
   * (every stale query refetches on reactivation).
   */
  reactivationGraceMs?: number;
  /**
   * Decides whether a failed query attempt (or a mutation attempt, when the
   * mutation enables retries) is retried. Receives the error, the attempt index
   * (starting at 0) and the attempt's HTTP status when known. A query's or
   * mutation's own `retry.shouldRetry` overrides it. Without it, every failed
   * attempt is retried. Use it to stop retrying permanent errors such as a 4xx.
   */
  shouldRetry?: ShouldRetry;
  /**
   * Milliseconds. Reactivation refetches that start in the same task (for
   * example every query on a screen that just resumed) are spread evenly
   * across this window, in activation order, instead of all starting at once.
   * Queries of an adapter that `coalescesRequests` are not spread. A value
   * that is not a finite positive number counts as 0. Default: 0 (all start
   * together).
   */
  reactivationStaggerMs?: number;
  /**
   * Foreground/background source. When set, `poll()` stops its timers while
   * the app is inactive and resumes them when it becomes active again. A value
   * without `isActive` and `subscribe` functions is ignored (with a warning in
   * development). Default: undefined (polls run regardless of app state).
   */
  activity?: ActivitySource;
  /**
   * Milliseconds. A `poll()` tick that is overdue when the app becomes active
   * again (or whose timer fires more than a second late, as happens when the
   * JS thread was suspended in the background) is rescheduled at a random
   * point within this window rather than firing immediately alongside every
   * other overdue poll. A value that is not a finite positive number counts
   * as 0. Default: 0 (overdue ticks fire immediately).
   */
  pollResumeJitterMs?: number;
}

export interface RetainOptions {
  /**
   * Milliseconds after which the lease releases itself. Omit to hold it until
   * the returned `release` is called.
   */
  ttl?: number;
}

export interface PrefetchOptions {
  /**
   * Milliseconds to keep the query active if nothing else reads it. Default:
   * `DEFAULT_PREFETCH_TTL` (10 s).
   */
  ttl?: number;
}

/** How long `prefetch()` keeps a query active when no `ttl` is given. */
export const DEFAULT_PREFETCH_TTL = 10_000;

/**
 * How long a suspense hold outlives its fetch settling when no reader commits
 * to claim it (the suspended tree was abandoned).
 */
const SUSPENSE_HOLD_TTL = 10_000;

/**
 * How long a failed cold fetch's error waits for a render to claim it. A
 * large or time-sliced tree can take far longer than a task to retry a
 * suspended render, and a reader that finds no hold refetches instead of
 * throwing. An error still unclaimed after this belongs to an abandoned tree,
 * so a later mount makes a fresh attempt instead of inheriting it.
 */
const UNCLAIMED_FAILURE_TTL = 1_000;

interface SuspenseHold {
  release: () => void;
  /** Resolves (never rejects) once the cold fetch settles. */
  settled: Promise<void> | undefined;
  /** The fetch this hold suspended on has settled. */
  done: boolean;
  /** That fetch failed and its error has been handed to a render. */
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
  /** With `store.onPersisted`, `_persisted` is set by the store's acknowledgement, not by `save()`. */
  storeAcksWrites: boolean = false;
  /**
   * Per-client static/dynamic key split for each entity shape (see
   * `shapeKeys` in EntityInstance.ts). Replaced wholesale when a typename
   * gains a second class, since the split depends on the other classes.
   */
  shapeKeyCache = new WeakMap<ValidatorDef<any>, EntityKeys>();

  /** See `QueryClientConfig.reactivationGraceMs`. */
  readonly reactivationGraceMs: number;
  /** See `QueryClientConfig.reactivationStaggerMs`. */
  readonly reactivationStaggerMs: number;
  /** See `QueryClientConfig.shouldRetry`. */
  readonly shouldRetry: ShouldRetry | undefined;

  /** Queries whose reactivation refetch waits for the current task's stagger flush. */
  private staggerQueue = new Set<QueryInstance<any>>();
  private staggerTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  /** Release functions of outstanding `retain()` / `prefetch()` leases. */
  private leases = new Set<() => void>();
  /**
   * Set during a lease's first run: the queries it reached whose first fetch
   * (or zero-delay refetch) is queued on a microtask. The lease starts them
   * before returning. See `retain()`.
   */
  private leaseStarts: Set<QueryInstance<any>> | undefined = undefined;
  /**
   * Leases taken by `retain()` inside a reactive computation, keyed by the
   * computation, with the run that took them. See `retain()`.
   */
  private reactiveLeases = new WeakMap<object, { run: number; releases: Array<() => void> }>();
  private warnedReactiveRetain = false;
  /** Leases taken by `useSuspenseQuery` for cold misses, by query instance key. */
  private suspenseHolds = new Map<number, SuspenseHold>();
  /**
   * Keys whose last cold failure expired unclaimed. The next attempt's failure
   * waits `SUSPENSE_HOLD_TTL` instead, so a reader slower than
   * `UNCLAIMED_FAILURE_TTL` gets the error after one retry rather than
   * refetching in a loop.
   */
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
    // All other keys pass through to the context, including the reserved ones
    // read above and `activity` / `pollResumeJitterMs`, which poll() reads
    // from there.
    this.context = { ...(rest as Record<string, unknown>), log: log ?? console, evictionMultiplier };
    this.gcManager =
      config.gcManager ??
      (this.isServer ? new NoOpGcManager() : new GcManager(this.handleEviction, evictionMultiplier));
    this.networkManager = config.networkManager ?? new NetworkManager();
    this.entityMap = new EntityStore((key, data, refs, merge, rest) => {
      if (merge) this.store.mergeEntity!(key, data, refs);
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
      this.entityMap.getEntity(key)?.recordDeleted();
    });
    if (typeof offDelete === 'function') this.storeUnsubscribes.push(offDelete);
    // A store that processes writes later says when a record is really there.
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

  /**
   * Whether every write handed to the store has been processed, so a skipped
   * write cannot be undone by a deletion the store has queued but not yet run.
   * A synchronous store is always settled.
   */
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
      // The snapshot fast path's static/dynamic split for this typename's
      // classes now has to account for the new class's fields.
      this.shapeKeyCache = new WeakMap();
    } else {
      this.typenameRegistry.set(typename, [def]);
    }
    this.noteTypenameFields(typename, def);
  }

  /**
   * Per entity def: whether another class of its typename declares a field it
   * lacks, this session or (via the store) an earlier one. Its records may
   * hold fields it does not parse, which its writes must keep.
   */
  private foreignFieldDefs = new WeakMap<ValidatorDef<any>, boolean>();
  /** Per typename: every top-level field its classes have declared (see `foreignFieldDefs`). */
  private typenameFields = new Map<string, Set<string>>();
  /** Per entity def: the fields other classes of its typename declare that can hold an entity (see `foreignRefFields`). */
  private foreignRefFieldsByDef = new WeakMap<ValidatorDef<any>, readonly string[]>();
  /** Whether any registered def lacks a field of its typename; false for an app whose typenames each have one class. */
  hasForeignFieldDefs: boolean = false;
  /**
   * Whether the store remembers each typename's field names across sessions
   * (`getEntityFieldNames`) and they cover every class that wrote a record it
   * holds (`entityFieldNamesComplete`), so a class not registered this
   * session is still known to `mayMissForeignFields`.
   */
  readonly storeKnowsTypenameFields: boolean;

  /**
   * Whether a stored record of this def's typename may hold fields the def
   * does not declare. Registers the def first if needed, since a hydration
   * parse runs before the apply registers it.
   *
   * @internal
   */
  mayMissForeignFields(def: ValidatorDef<any>): boolean {
    let verdict = this.foreignFieldDefs.get(def);
    if (verdict === undefined) {
      this.registerEntityDef(def);
      verdict = this.foreignFieldDefs.get(def);
      if (verdict === undefined) {
        // Not a class but a typename's merged def (a streamed event's root).
        // Registering a new class replaces the merged def, so this verdict
        // cannot go stale.
        const fields = def.typenameValue !== undefined ? this.typenameFields.get(def.typenameValue) : undefined;
        const shape = def.shape as Record<string, unknown> | undefined;
        verdict = fields !== undefined && shape !== undefined && fields.size > Object.keys(shape).length;
        this.foreignFieldDefs.set(def, verdict);
      }
    }
    return verdict;
  }

  /**
   * Top-level fields that other classes of this def's typename declare, this
   * def does not, and that can hold an entity. Only these can hold child
   * references that a full payload of this def leaves in the data. Cached per
   * def until another class of the typename registers.
   *
   * @internal
   */
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

  /**
   * Folds a newly registered def's fields into its typename's field set and
   * the store's, then re-derives which of the typename's defs lack one. Runs
   * once per def and client.
   */
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
    // Every declared name, not just the new ones: the store forgets names no
    // class has declared for a while.
    this.store.addEntityFieldNames?.(typename, declared);
    // Every registered def's fields are in the set, so a def lacks one of
    // them exactly when the set is larger than its shape.
    for (const d of this.typenameRegistry.get(typename)!) {
      // A new class may declare a known field name with an entity-holding
      // def, so every def's ref fields recompute.
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

    // A reader may have activated it earlier in this task with its start still
    // queued. The lease starts it too.
    this.leaseStarts?.add(queryInstance);

    return queryInstance.relay;
  }

  // ======================================================
  // Leases (retain / prefetch)
  // ======================================================

  /**
   * Keeps the queries `fn` reads active (fetched, subscribed, and exempt from
   * GC) until the returned `release` is called, or for `ttl` milliseconds,
   * whichever comes first. Use it to keep a hidden surface's queries warm, or
   * to start the queries a likely next screen needs.
   *
   * `fn` runs immediately with this client as the `QueryClientContext`, and
   * again whenever what it reads changes (for example a Signal param). A query
   * is held when `fn` reads one of its fields (`isReady`, `value`, ...), or
   * when `fn` returns its promise or an array of them:
   *
   * ```ts
   * const release = client.retain(() => [fetchQuery(GetTokens), fetchQuery(GetPrices, { ids })]);
   * // later, when the surface is gone for good:
   * release();
   * ```
   *
   * A reader that mounts while the lease is held joins the already active
   * query: no new request, and the data (if it has arrived) on its first
   * render. Releasing never interrupts other readers; when the last one goes,
   * the query deactivates and its `gcTime` starts as usual. `release` is
   * idempotent.
   *
   * The first run's fetches start before `retain` returns, ahead of anything
   * already on the microtask queue (such as a render React scheduled for the
   * same tap). A query that depends on another's result starts once that
   * result arrives, as with any reader.
   *
   * Call `retain` from an event handler or effect, not a reactive computation:
   * starting a fetch runs adapter code, and a rerunning computation would take
   * a new lease each run. Called from one anyway, it warns in development,
   * starts its fetches on their usual microtask, and releases the leases the
   * computation's previous run took.
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

  /**
   * `retain()`, with `startNow` choosing whether the first run's fetches start
   * before returning or on their usual microtask. `useSuspenseQuery` leases
   * from inside a render, where adapter code must not run, so it passes false.
   */
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
      // Run now, so the queries activate (and a synchronous store hydrates
      // them) before this returns, not on Signalium's next flush.
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
   * Starts `QueryClass` with `params` now and keeps it active for `ttl`
   * milliseconds (default {@link DEFAULT_PREFETCH_TTL}), or until the returned
   * `release` is called. Meant for the tap that commits to a navigation: the
   * destination's reader, mounting within the window, reuses the in-flight or
   * finished fetch and renders the data on its first render if it has arrived.
   *
   * The `ttl` is an upper bound. The lease ends even if the fetch is still in
   * flight (offline, or a topic never fulfilled), which aborts it unless a
   * reader has joined.
   *
   * With a synchronous store a fresh cached result is applied without a
   * request. A stale one is shown and refetched, as on any activation.
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
   * A cold miss takes a hold that keeps the query active while the render is
   * suspended, since React discards a suspended render without subscribing.
   * The reader's commit releases it (`releaseSuspenseHold`); otherwise it
   * releases itself `SUSPENSE_HOLD_TTL` after the fetch settles. A query whose
   * last fetch failed is refetched once per hold: when that attempt fails too,
   * `error` is set and the hold is dropped, so the caller can throw it. A
   * failure no render claims within `UNCLAIMED_FAILURE_TTL` (the suspended
   * tree was abandoned) drops the hold, so a later mount makes a new attempt.
   * If that attempt also fails, its error waits `SUSPENSE_HOLD_TTL` for a
   * render, so even a slow reader reaches its error boundary.
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
      // Hydrated by the activation: render it, and keep the hold until the reader commits.
      this.expireSuspenseHold(key, hold);
      return { promise: undefined, key };
    }

    if (relay.isPending && hold.done) {
      // The fetch this hold waited for settled, and another has started since
      // (a refetch from elsewhere). Suspend on that one: the settled promise
      // has already resolved, and throwing it again would re-render at once.
      clearTimeout(hold.timer);
      hold.timer = undefined;
      hold.done = false;
      hold.failed = false;
      hold.settled = undefined;
    }

    if (!relay.isPending) {
      if (hold.done) {
        // The fetch this hold waited for failed. Keep the hold until the next
        // task: React re-renders a throwing component once more before giving
        // up, and that render must throw the same error, not refetch. A later
        // mount (an error boundary reset) gets a fresh hold and a new attempt.
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
      // A failed or not-yet-started fetch: start it now rather than after the activation's refetch hop.
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
   *
   * `copyInput: false` (a fetch result or a cached record, handed over to the
   * client) copies a nested object only where a parsed value differs from it.
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

  /** `existing`: the instance the caller already looked up under `key`, if any. */
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

    // The apply writes entities the event updates, not ones it creates. A
    // created entity is written once a written record references it, or below
    // once the root is known to be retained. Only an event with a new root can
    // create entities that need collecting here.
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
        // Half applied: nothing built from it can stay.
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

    // The created root (and what it created) is written when a live array is
    // about to retain it, or when the store already holds a record of it: a
    // collected query's cache can still hold this entity, and the event is
    // that record's only chance to stay fresh. An event is partial, so the
    // write merges over the record. It comes before routing so that a failed
    // write routes nothing. A store that can't say what it holds (no
    // `hasEntity`) is not written, so it never accumulates unreferenced records.
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
    // The store is asked only when no live array retains the root, and only
    // when there is something to write; its answer is handed to save().
    let held: boolean | undefined;
    if (!entity._persisted && entity._pendingWrites === 0) {
      if (!retains) held = this.store.hasEntity?.(key);
      if (retains || held === true) {
        try {
          entity.save(held);
        } catch (e) {
          this.context.log?.warn?.('Failed to apply mutation event', e);
          this.evictUnlessAdopted(entity, created!);
          return;
        }
      }
    }

    // The dry run found no collection to route into: routing again would
    // only recompute the constraint hashes.
    if (matched) this.routeEvent(typename, entity.data, key, type, eventSource);
    else this.evictUnlessAdopted(entity, created!);
  }

  /**
   * Evicts the root an event created unless an entity that existed before the
   * event now references it. References from entities the same event created
   * (the root included) don't count: they were only reachable through the root.
   */
  private evictUnlessAdopted(root: EntityInstance, created: Set<EntityInstance>): void {
    let createdHolders = 0;
    for (const c of created) if (c.entityRefs?.has(root)) createdHolders++;
    if (root.refCount <= createdHolders) this.evictCreated(root, created);
  }

  /**
   * Evicts the root an event created, along with every entity the event
   * created that is no longer referenced. They were never written, and
   * lingering until `gcTime` would let a later event write them as orphans.
   */
  private evictCreated(root: EntityInstance, created: Set<EntityInstance>): void {
    root.evict();
    // Evicting one releases what it held; repeat until nothing more is free.
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

  /**
   * Entities whose write was requested while an apply was still reifying
   * them; written once that apply is done.
   */
  private deferredWrites: Set<EntityInstance> | undefined;

  /** @internal */
  deferWrite(entity: EntityInstance): void {
    (this.deferredWrites ??= new Set()).add(entity);
  }

  /**
   * Writes the deferred entities in the order they were deferred: children
   * before their parents. If a write fails, the rest are marked so the next
   * apply writes them.
   */
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

  /**
   * After a failed apply, what it deferred may be half reified, so nothing is
   * written. Those records are stale and the next apply writes them.
   */
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
   * Called by a query that queued its start (or a zero-delay refetch) on a
   * microtask, so a lease in its first run can start it before returning.
   *
   * @internal
   */
  noteDeferredStart(instance: QueryInstance<any>): void {
    this.leaseStarts?.add(instance);
  }

  /**
   * Queues a reactivation refetch. Everything queued in the same task is
   * started from one flush, spread evenly across `reactivationStaggerMs` in
   * the order the queries reactivated, so the first one starts right away.
   * Queries whose adapter `coalescesRequests` all start right away instead.
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
   * Evicts the root entity of a non-entity result that `owner` no longer
   * shows (its params changed, or it was collected), unless another instance
   * with the same params still shows it. A root already gone from the entity
   * map is skipped: its key now belongs to the root of whichever query shows
   * those params.
   *
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
      instance.stopSubscription();
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
 * The reactive computation (and its run) currently executing, if any. Signalium
 * has no public API for this: a signal read records its consumer, so read a
 * throwaway signal and look at what it recorded. Undefined when the shape
 * isn't the expected one.
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

/**
 * Reads the query promises `retain`'s callback returned, so the lease's
 * watcher depends on them and keeps them active. `isReady` changes once per
 * query, so the watcher reruns at most once for each.
 */
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
