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
  private reconnectsAtDeactivate: number = 0;
  private currentParams: QueryParams | undefined = undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  /** Errored, not aborted. Disables the reactivation grace. */
  private lastFetchFailed: boolean = false;
  /** Not set by poll(): it delivers by refetching, which moves `updatedAt`. */
  private lastPushAt: number | undefined = undefined;
  /** Lets a queued reactivation refetch detect that another fetch overtook it. */
  private fetchStarts: number = 0;
  private reactivationQueuedAt: number = -1;

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
          this.reconnectsAtDeactivate = this.queryClient.networkManager.reconnects;

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
              // No grace after a reconnect: data may have been missed while offline.
              const withinGrace =
                activating &&
                !wasPaused &&
                !paramsDidChange &&
                this.queryClient.networkManager.reconnects === this.reconnectsAtDeactivate &&
                this.isWithinReactivationGrace;
              if (refreshStaleOnReconnect && this.isStale && !withinGrace) {
                if (this.queryClient.reactivationStaggerMs > 0) {
                  this.reactivationQueuedAt = this.fetchStarts;
                  this.queryClient.scheduleReactivationRefetch(this);
                } else {
                  this.runDebounced();
                }
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

  /** Runs once, inside the read that first activates the relay. */
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
      // Adapter and app code must not touch signals while the relay is the current consumer.
      queueMicrotask(() => this.startSubscriptionAndFetch());
    }
  }

  private discardCorruptCache(error: unknown): void {
    const qc = this.queryClient;
    qc.store.deleteQuery(this.storageKey);
    qc.getContext().log?.warn?.('Failed to initialize query, the query cache may be corrupted or invalid', error);
  }

  private hydrate(cached: CachedQuery | undefined): void {
    if (cached === undefined) return;

    try {
      // Keep an invalidation made before the cache loaded.
      if (this.updatedAt !== 0) this.updatedAt = cached.updatedAt;
      this.relayState.value = this.applyData(cached.value, false, false, cached.preloadedEntities);
    } catch (error) {
      // Never applied, so drop the timestamp and let the query fetch.
      this.updatedAt = undefined;
      this.discardCorruptCache(error);
    }
  }

  private startSubscriptionAndFetch(): void {
    // If deactivated meanwhile, update() fetches on reactivation.
    if (!this._isActive || this.isPaused) {
      return;
    }

    try {
      // Wire up subscribe before the first fetch so adapters that resolve
      // `send()` via stream events (TopicQuery) are on the wire by the time
      // `send()` awaits.
      this.reconcileSubscription();

      // refetch() may have started a fetch since activation.
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
      this.notePush();
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
      // `TopicQuery.getConfig.subscribe` passes this to its adapter.
      (this._executionCtx as unknown as Record<string, unknown>)._notePush = this.notePush;
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

    try {
      const result = await withRetry(
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
      // An aborted fetch may have been replaced by one that failed.
      if (!signal.aborted) this.lastFetchFailed = false;
      return result;
    } catch (error) {
      if (!signal.aborted) this.lastFetchFailed = true;
      throw error;
    }
  }

  private runQueryImmediately(): void {
    this.fetchStarts++;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    this._abortController?.abort();
    this._abortController = new AbortController();
    this._fetchNextAbort?.abort();
    this._fetchNextAbort = undefined;
    this._fetchNextPromise = undefined;
    this.relayState.setPromise(this.runQuery());
  }

  private runDebounced(extraDelay: number = 0): void {
    if (this.relayState.isPending) return;

    const debounce = this.config?.debounce ?? 0;
    // Drops a queued reactivation refetch, which would replace this timer.
    this.reactivationQueuedAt = -1;

    clearTimeout(this.debounceTimer);

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.runQueryImmediately();
    }, debounce + extraDelay);
  }

  /** Runs a task after queueing. Skipped if a fetch started since, rather than aborting and repeating it. */
  runReactivationRefetch(delay: number): void {
    if (!this._isActive || this.isPaused || this.relayState.isPending) return;
    const queuedAt = this.reactivationQueuedAt;
    if (this.fetchStarts !== queuedAt) return;

    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(
      () => {
        this.debounceTimer = undefined;
        if (this.fetchStarts !== queuedAt) return;
        this.runQueryImmediately();
      },
      (this.config?.debounce ?? 0) + delay,
    );
  }

  private notePush = (): void => {
    if (this._isActive) this.lastPushAt = Date.now();
  };

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
    // Cancels a waiting staggered refetch, which would reset the pages.
    this.fetchStarts++;
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
    // 0 means invalidated, whatever the staleTime.
    if (this.updatedAt === undefined || this.updatedAt === 0) {
      return true;
    }

    const staleTime = this.config?.staleTime ?? 0;
    return Date.now() - this.updatedAt >= staleTime;
  }

  private get isWithinReactivationGrace(): boolean {
    const { updatedAt } = this;
    if (updatedAt === undefined || updatedAt === 0 || this.lastFetchFailed) return false;
    const grace = this.config?.reactivationGraceMs ?? this.queryClient.reactivationGraceMs;
    if (!(grace > 0)) return false;
    const freshAt = Math.max(updatedAt, this.lastPushAt ?? 0);
    return Date.now() - freshAt < grace;
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
