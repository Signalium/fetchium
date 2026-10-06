import {
  relay,
  reactiveSignal,
  type RelayState,
  ReactivePromise,
  type ReadonlySignal,
  type DeactivateOptions,
} from 'signalium';
import { NetworkMode, type QueryResult, type EntityDef } from './types.js';
import {
  type QueryClient,
  type QueryParams,
  type QueryConfigOptions,
  extractParamsForKey,
  queryKeyFor,
  CachedQuery,
} from './QueryClient.js';
import type { MaybePromise } from './query-types.js';
import { DEFAULT_GC_TIME } from './stores/shared.js';
import { GcKeyType } from './GcManager.js';
import { Query, QueryDefinition, type ResolvedRetryConfig, resolveRetryConfig } from './query.js';
import { EntityInstance } from './EntityInstance.js';
import { hashValue } from 'signalium/utils';
import { withRetry } from './retry.js';

function isThenable<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}

/**
 * Thin fetch/relay orchestrator. Data management (proxy, notifier, child refs,
 * live data) is fully delegated to a root EntityInstance.
 */
export class QueryInstance<T extends Query> {
  def: QueryDefinition<any, any, any>;
  queryKey: number;
  storageKey: number = -1;

  /** The public-facing ReactivePromise returned to consumers. */
  readonly relay: ReactivePromise<QueryResult<T>>;

  private queryClient: QueryClient;
  private initialized: boolean = false;
  private updatedAt: number | undefined = undefined;
  private params: QueryParams | undefined = undefined;

  private unsubscribe?: () => void = undefined;
  private lastSubscribeFn: QueryConfigOptions['subscribe'] = undefined;

  private _relayState: RelayState<QueryResult<T>> | undefined = undefined;
  private _isActive: boolean = false;
  private wasPaused: boolean = false;
  private currentParams: QueryParams | undefined = undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  // Invalidates on any signal consumed by getConfig() (such as
  // responseNotifier, fired by the adapter after each fetch). Param
  // changes are handled separately: getOrCreateExecutionContext
  // replaces this wholesale to force recomputation against the new ctx.
  private _resolvedOptions: ReadonlySignal<{
    config: QueryConfigOptions | undefined;
    retryConfig: ResolvedRetryConfig;
  }> = reactiveSignal(() => this.def.resolveOptions(this._executionCtx!));

  get config(): QueryConfigOptions | undefined {
    if (this._executionCtx === undefined) return undefined;
    return this._resolvedOptions.value.config;
  }

  get retryConfig(): ResolvedRetryConfig {
    if (this._executionCtx === undefined) return resolveRetryConfig(undefined);
    return this._resolvedOptions.value.retryConfig;
  }

  /** Cancels in-flight fetches and retry waits. */
  private _abortController: AbortController | undefined = undefined;

  /** Cached execution context, recreated only when storageKey (params) changes. */
  private _executionCtx: Query | undefined = undefined;
  private _executionCtxKey: number = -1;

  /** Root entity that holds parsed data, proxy, child refs, and bindings.
   *  For entity results, this is undefined until the first apply discovers it. */
  rootEntity: EntityInstance | undefined;

  /** Extra methods (__refetch, __fetchNext) attached to the root entity proxy. */
  private _extraMethods: Record<string, (...args: unknown[]) => unknown> = {};

  /** Query id injected as QUERY_ID on non-entity payloads. */
  private _queryId: number = 0;

  get key(): number {
    return this.queryKey;
  }

  private get relayState(): RelayState<QueryResult<T>> {
    if (IS_DEV && !this._relayState) {
      throw new Error('Relay state not initialized');
    }
    return this._relayState!;
  }

  constructor(
    def: QueryDefinition<any, any, any>,
    queryClient: QueryClient,
    queryKey: number,
    params: QueryParams | undefined,
  ) {
    this.def = def;
    this.queryClient = queryClient;
    this.queryKey = queryKey;
    this.params = params;

    this._extraMethods = { __refetch: this.refetch };
    if (def.statics.hasSendNext) {
      this._extraMethods.__fetchNext = this.fetchNext;
    }

    // Compute the query id used for QUERY_ID injection on non-entity results.
    const extractedParams = extractParamsForKey(params);
    this._queryId = extractedParams !== undefined ? hashValue(extractedParams) : 0;

    // Create the relay whose value is the root entity's proxy (stable identity)
    this.relay = relay<QueryResult<T>>(
      state => {
        this._relayState = state;

        // When pausing (vs a genuine cleanup) we tear down the fetch/subscription
        // but skip GC, so resuming reuses the cached result instead of refetching.
        const deactivate = ({ isPausing = false }: DeactivateOptions = {}) => {
          this._isActive = false;

          clearTimeout(this.debounceTimer);
          this.debounceTimer = undefined;

          this._abortController?.abort();
          this._abortController = undefined;

          this._fetchNextAbort?.abort();
          this._fetchNextAbort = undefined;
          this._fetchNextPromise = undefined;

          this.stopSubscription();

          if (isPausing) return;

          const gcTime = this.config?.gcTime ?? DEFAULT_GC_TIME;
          this.queryClient.gcManager.schedule(this.queryKey, gcTime, GcKeyType.Query);
        };

        const update = (activating: boolean = false) => {
          const { wasPaused, isPaused, initialized } = this;
          this.wasPaused = isPaused;

          if (isPaused && !wasPaused && initialized) {
            deactivate({ isPausing: true });
            return;
          }

          this._isActive = true;

          const newExtractedParams = extractParamsForKey(this.params);
          const newStorageKey = queryKeyFor(this.def, newExtractedParams);

          const paramsDidChange = newStorageKey !== this.storageKey;

          if (paramsDidChange) {
            this.currentParams = newExtractedParams as QueryParams;
            this.storageKey = newStorageKey;
          }

          this.getOrCreateExecutionContext();

          if (!this.initialized) {
            this.queryClient.activateQuery(this);
            this.initialize();
          } else if (wasPaused || activating) {
            this.queryClient.activateQuery(this);

            if (activating && this.updatedAt !== undefined) {
              this.reconcileSubscription();
            }

            // If the relay shows pending but the abort controller is gone, the
            // previous fetch was aborted during deactivation.  runDebounced()
            // would bail out because isPending is still true from the doomed
            // promise.  Force an immediate refetch so the new setPromise() call
            // replaces _promise, causing the stale AbortError rejection to hit
            // the `promise !== this._promise` guard and be silently ignored.
            if (this.relayState.isPending && this._abortController === undefined) {
              this.runQueryImmediately();
            } else {
              const refreshStaleOnReconnect = this.config?.refreshStaleOnReconnect ?? true;
              if (refreshStaleOnReconnect && this.isStale) {
                this.runDebounced();
              }
            }
          } else if (paramsDidChange) {
            // Force rebuild: the running subscriber captured the old params.
            this.lastSubscribeFn = undefined;
            this.reconcileSubscription();
            this.runDebounced();
          }
        };

        update(true);

        return {
          update,
          deactivate,
        };
      },
      { desc: `Query(${def.statics.id})` },
    );
  }

  /** Apply raw data (fresh or cached) to the root entity and return the proxy. */
  private applyData(
    data: unknown,
    persist: boolean,
    appendMode: boolean = false,
    preloadedEntities?: import('./query-types.js').PreloadedEntityMap,
  ): QueryResult<T> {
    const def = this.def;
    this.rootEntity = this.queryClient.parseAndApplyRootEntity(
      data,
      this._queryId,
      def.statics.shape,
      persist,
      appendMode,
      preloadedEntities,
    );

    // Attach extra methods and getters on first discovery
    if (this.rootEntity._extraMethods === undefined) {
      this.rootEntity._extraMethods = this._extraMethods;
      this.rootEntity._extraGetters = {
        __hasNext: () => this.hasNext,
        __isFetchingNext: () => this._fetchNextPromise !== undefined,
      };
    }

    return this.rootEntity.getProxy(def.statics.shape as unknown as EntityDef) as QueryResult<T>;
  }

  /** Save query metadata (the __entityRef pointer, updatedAt, ref set). */
  private saveQueryMetadata(): void {
    if (this.rootEntity === undefined || this.updatedAt === undefined) return;
    const refs = new Map(this.rootEntity.entityRefs ?? []);
    refs.set(this.rootEntity, 1);
    this.queryClient.saveQueryData(
      this.def,
      this.storageKey,
      { __entityRef: this.rootEntity.key },
      this.updatedAt,
      refs,
    );
  }

  /**
   * Runs once, from the relay's first activation. That activation happens
   * inside the read that watched the relay (for React, during render).
   *
   * When the store answers synchronously (SyncQueryStore), the cached value is
   * applied right here, so the activating read, and the first render, already
   * see it. Subscribing and fetching wait for the next microtask: both call
   * into adapter and app code that may read or write signals, which must not
   * run while the relay's computation is the current consumer. A microtask
   * rather than a timer keeps the first fetch off the macrotask queue.
   *
   * With an asynchronous store (AsyncQueryStore), the cache resolves on a later
   * tick, outside the activating read, and everything runs from there.
   */
  private initialize(): void {
    this.initialized = true;

    let loaded: MaybePromise<CachedQuery | undefined>;

    try {
      loaded = this.queryClient.loadCachedQuery(this.def, this.storageKey);
    } catch (error) {
      this.discardCorruptCache(error);
      loaded = undefined;
    }

    if (isThenable(loaded)) {
      loaded.then(
        cached => {
          this.hydrate(cached);
          this.startSubscriptionAndFetch();
        },
        error => {
          this.discardCorruptCache(error);
          this.startSubscriptionAndFetch();
        },
      );
    } else {
      this.hydrate(loaded);
      queueMicrotask(() => this.startSubscriptionAndFetch());
    }
  }

  private discardCorruptCache(error: unknown): void {
    const qc = this.queryClient;
    qc.store.deleteQuery(this.storageKey);
    qc.getContext().log?.warn?.('Failed to initialize query, the query cache may be corrupted or invalid', error);
  }

  /** Resolves the relay with a cached value. */
  private hydrate(cached: CachedQuery | undefined): void {
    if (cached === undefined) return;

    try {
      // Keep an invalidation made before the cache loaded.
      if (this.updatedAt !== 0) this.updatedAt = cached.updatedAt;
      this.relayState.value = this.applyData(cached.value, false, false, cached.preloadedEntities);
    } catch (error) {
      // Unusable entry: treat it as a miss so the query still fetches, instead
      // of trusting a timestamp whose data was never applied.
      this.updatedAt = undefined;
      this.discardCorruptCache(error);
    }
  }

  /** Starts the subscription, then the first fetch if there is no fresh cached value. */
  private startSubscriptionAndFetch(): void {
    // Deactivated in the meantime: update() fetches on reactivation, since the
    // relay is still pending (or stale) with no fetch in flight.
    if (!this._isActive || this.isPaused) {
      return;
    }

    try {
      // Wire up subscribe before the first fetch so adapters that resolve
      // `send()` via stream events (TopicQuery) are on the wire by the time
      // `send()` awaits.
      this.reconcileSubscription();

      // Skip if something already started a fetch since activation (refetch()).
      const fetchInFlight = this.relayState.isPending && this._abortController !== undefined;
      if (this.isStale && !fetchInFlight) {
        this.runQueryImmediately();
      }
    } catch (error) {
      this.relayState.setError(error as Error);
    }
  }

  /** Tears down the running subscription, if any. */
  stopSubscription(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.lastSubscribeFn = undefined;
  }

  private reconcileSubscription(): void {
    // A fetch aborted by deactivate() still reaches this from runQuery's
    // finally. Subscribing then would leave a subscription nothing tears down.
    if (!this._isActive) return;

    const subscribeFn = this.config?.subscribe;
    if (subscribeFn === this.lastSubscribeFn) return;

    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.lastSubscribeFn = subscribeFn;

    if (!subscribeFn) return;

    const ctx = this._executionCtx;
    this.unsubscribe = subscribeFn.call(ctx, (event: import('./types.js').MutationEvent) => {
      // Collections register under their parent entity's key, so the query key
      // matches nothing. Undefined until the first apply: no collection yet.
      event.__eventSource = this.rootEntity?.key;
      this.queryClient.applyMutationEvent(event);
    });
  }

  private getOrCreateExecutionContext(): Query {
    if (this._executionCtx === undefined || this._executionCtxKey !== this.storageKey) {
      this._executionCtxKey = this.storageKey;
      this._executionCtx = this.def.createExecutionContext(
        (this.currentParams ?? {}) as Record<string, unknown>,
        this.queryClient.getContext(),
      );
      this._executionCtx.refetch = () => this.refetch();
      this._executionCtx.rawFetchNext = this.def.statics.rawFetchNext;
      // `TopicQuery.getConfig.subscribe` reads `_topicAdapter` from the ctx;
      // set it eagerly so subscribe/unsubscribe work on the cache-fresh and
      // pre-fulfilled paths where `send()` never runs.
      (this._executionCtx as unknown as Record<string, unknown>)._topicAdapter = this.queryClient.getAdapter(
        this.def.statics.adapterClass,
      );

      this._resolvedOptions = reactiveSignal(() => this.def.resolveOptions(this._executionCtx!));
    }

    return this._executionCtx;
  }

  private async runQuery(): Promise<QueryResult<T>> {
    const def = this.def;

    if (this.isPaused) {
      throw new Error('Query is paused due to network status');
    }

    const ctx = this.getOrCreateExecutionContext();
    const adapter = this.queryClient.getAdapter(def.statics.adapterClass);
    const signal = this._abortController?.signal ?? new AbortController().signal;

    return withRetry(
      async () => {
        try {
          const freshData = await adapter.send(ctx, signal);
          this.updatedAt = Date.now();

          const result = this.applyData(freshData, true);
          this.saveQueryMetadata();

          return result;
        } finally {
          // In finally so reactive getConfig() reacts to error responses
          // (e.g. 404 → subscribe: undefined) even when applyData throws.
          this.reconcileSubscription();
        }
      },
      this.retryConfig,
      signal,
    );
  }

  private runQueryImmediately(): void {
    this._abortController?.abort();
    this._abortController = new AbortController();
    this._fetchNextAbort?.abort();
    this._fetchNextAbort = undefined;
    this._fetchNextPromise = undefined;
    this.relayState.setPromise(this.runQuery());
  }

  private runDebounced(): void {
    if (this.relayState.isPending) return;

    const debounce = this.config?.debounce ?? 0;

    clearTimeout(this.debounceTimer);

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.runQueryImmediately();
    }, debounce);
  }

  // ======================================================
  // Public methods
  // ======================================================

  refetch = (): ReactivePromise<QueryResult<T>> => {
    if (this.relayState.isPending) return this.relay;
    this.runQueryImmediately();
    return this.relay;
  };

  markStale(): void {
    this.updatedAt = 0;
    if (this._isActive && !this.isPaused) {
      this.runDebounced();
    }
  }

  get resolvedParams(): QueryParams | undefined {
    return this.currentParams;
  }

  /** In-flight fetchNext promise for deduplication. */
  private _fetchNextPromise: Promise<QueryResult<T>> | undefined = undefined;

  /** Cancels in-flight fetchNext requests. */
  private _fetchNextAbort: AbortController | undefined = undefined;

  fetchNext = (): Promise<QueryResult<T>> => {
    if (this.updatedAt === undefined) {
      throw new Error('Cannot call __fetchNext before initial data has loaded');
    }
    if (this._fetchNextPromise !== undefined) {
      return this._fetchNextPromise;
    }
    // Schedule notification so __isFetchingNext becomes true reactively.
    // Must be async to avoid "dirtied after consumed" when called from
    // within a reactive context (the proxy consumes the notifier on access).
    queueMicrotask(() => this.rootEntity?.notify());
    this._fetchNextPromise = this.runFetchNext().then(
      result => {
        this._fetchNextPromise = undefined;
        // Notify so __isFetchingNext transitions to false.
        // applyData already notified for the data change; this second
        // notify is needed because _fetchNextPromise was still set at
        // that point and is only cleared here.
        this.rootEntity?.notify();
        return result;
      },
      error => {
        this._fetchNextPromise = undefined;
        this.rootEntity?.notify();
        throw error;
      },
    );
    return this._fetchNextPromise;
  };

  private get hasNext(): boolean {
    if (this.rootEntity === undefined || !this._executionCtx) return false;
    const adapter = this.queryClient.getAdapter(this.def.statics.adapterClass);
    if (!adapter.hasNext) return false;
    this._executionCtx.resultData = this.rootEntity.data;
    return adapter.hasNext(this._executionCtx);
  }

  private async runFetchNext(): Promise<QueryResult<T>> {
    const def = this.def;
    this._fetchNextAbort = new AbortController();
    const signal = this._fetchNextAbort.signal;
    const ctx = this.getOrCreateExecutionContext();
    ctx.resultData = this.rootEntity!.data;
    const adapter = this.queryClient.getAdapter(def.statics.adapterClass);

    return withRetry(
      async () => {
        const freshData = await adapter.sendNext!(ctx, signal);
        this.updatedAt = Date.now();

        const result = this.applyData(freshData, true, true);
        this.saveQueryMetadata();

        return result;
      },
      this.retryConfig,
      signal,
    );
  }

  // ======================================================
  // Internal computed properties
  // ======================================================

  private get isStale(): boolean {
    // Never loaded, or invalidated (`markStale()`), whatever the staleTime.
    if (this.updatedAt === undefined || this.updatedAt === 0) {
      return true;
    }

    const staleTime = this.config?.staleTime ?? 0;
    return Date.now() - this.updatedAt >= staleTime;
  }

  private get isPaused(): boolean {
    const networkMode = this.config?.networkMode ?? NetworkMode.Online;

    if (networkMode === NetworkMode.Always) {
      return false;
    }

    const isOnline = this.queryClient.networkManager.getOnlineSignal().value;

    switch (networkMode) {
      case NetworkMode.Online:
        return !isOnline;
      case NetworkMode.OfflineFirst:
        return !isOnline && this.updatedAt === undefined;
      default:
        return false;
    }
  }
}
