import {
  relay,
  reactiveSignal,
  type RelayState,
  ReactivePromise,
  type ReadonlySignal,
  type DeactivateOptions,
  settled,
  isSignal,
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
import { getFailedResponseStatus, withRetry, type WithRetryOptions } from './retry.js';

function isThenable<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** Open from a microtask first-fetch start until the pending flush runs. A deactivation inside it keeps the fetch. */
let startWindow = 0;
let startWindowOpen = false;

const closeStartWindow = (): void => {
  startWindowOpen = false;
};

function openStartWindow(): number {
  if (!startWindowOpen) {
    startWindowOpen = true;
    startWindow++;
    void settled().then(closeStartWindow, closeStartWindow);
  }
  return startWindow;
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
  /** Bumped to cancel a zero-delay refetch, which runs on a microtask that can't be cleared. */
  private debounceGeneration: number = 0;
  private pendingDebouncedRun: (() => void) | undefined = undefined;
  private startPending: boolean = false;
  private pendingRestart: (() => void) | undefined = undefined;
  /** Rejects a restart parked while offline or inactive. */
  private parkedRestart: ((error: unknown) => void) | undefined = undefined;
  /** First fetch a same-task unmount let finish. GC waits for it to settle. */
  private keptFetchSignal: AbortSignal | undefined = undefined;
  /** Aborted fetch that leaves the relay pending instead of rejected. */
  private heldAbortSignal: AbortSignal | undefined = undefined;
  private hasSignalParams: boolean = false;
  private firstFetchController: AbortController | undefined = undefined;
  /** Bumped by `abortForDestroy()` so a late response is dropped. */
  private destroyCount: number = 0;
  private firstFetchWindow: number = 0;
  /** The next activation refetches instead of showing the AbortError. */
  private abortedByDeactivation: boolean = false;
  /** The last fetch ended in an error (not an abort). Disables the reactivation grace. */
  private lastFetchFailed: boolean = false;
  private rejectedByConfig: boolean = false;
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
    error?: unknown;
  }> = reactiveSignal(() => this.resolveOptionsSafely());

  // A throw here would escape Signalium's flush and stall its scheduler.
  private resolveOptionsSafely() {
    try {
      return this.def.resolveOptions(this._executionCtx!);
    } catch (error) {
      return { config: undefined, retryConfig: resolveRetryConfig(undefined), error };
    }
  }

  private get configError(): unknown {
    if (this._executionCtx === undefined) return undefined;
    return this._resolvedOptions.value.error;
  }

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

  /** Query id injected as QUERY_ID on non-entity payloads. Follows the params. */
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
    if (params !== undefined) {
      for (const key in params) {
        if (isSignal(params[key])) {
          this.hasSignalParams = true;
          break;
        }
      }
    }

    // Create the relay whose value is the root entity's proxy (stable identity)
    this.relay = relay<QueryResult<T>>(
      state => {
        this._relayState = state;

        // When pausing (vs a genuine cleanup) we tear down the fetch/subscription
        // but skip GC, so resuming reuses the cached result instead of refetching.
        const deactivate = ({ isPausing = false }: DeactivateOptions = {}) => {
          this._isActive = false;
          this.reconnectsAtDeactivate = this.queryClient.networkManager.reconnects;

          this.cancelDebounced();
          // Cancel a start that hasn't run. The next activation restarts it.
          this.startPending = false;

          const controller = this._abortController;
          if (controller !== undefined && !controller.signal.aborted) {
            // A topic query's send() may wait on the subscription torn down here.
            const sameTask =
              controller === this.firstFetchController && startWindowOpen && this.firstFetchWindow === startWindow;
            const keepFirstFetch = !isPausing && sameTask && this.unsubscribe === undefined;
            if (keepFirstFetch) {
              // Mounted and unmounted in one task: let the first fetch finish.
              this.firstFetchController = undefined;
              if (this.relayState.isPending) this.keptFetchSignal = controller.signal;
            } else {
              if (this.relayState.isPending) {
                this.abortedByDeactivation = true;
                if (!sameTask && (isPausing ? this.holdsDeactivationAbort() : this.relayState.value === undefined)) {
                  this.heldAbortSignal = controller.signal;
                }
              }
              controller.abort();
              this._abortController = undefined;
            }
          } else {
            this._abortController = undefined;
          }

          this._fetchNextAbort?.abort();
          this._fetchNextAbort = undefined;
          this._fetchNextPromise = undefined;

          this.stopSubscription();

          if (isPausing) return;

          // A parked restart has no fetch to abort, so settle it here.
          const parked = this.parkedRestart;
          if (parked !== undefined) {
            this.parkedRestart = undefined;
            this.abortedByDeactivation = true;
            if (!this.holdsDeactivationAbort()) parked(abortError());
          }

          // A kept first fetch schedules collection when it settles.
          if (this.keptFetchSignal !== undefined) return;
          this.scheduleGc();
        };

        const update = (activating: boolean = false) => {
          if (this.stoppedByDestroy()) return;
          const { wasPaused, isPaused, initialized } = this;
          this.wasPaused = isPaused;

          if (isPaused && !wasPaused && initialized) {
            deactivate({ isPausing: true });
            return;
          }

          this._isActive = true;
          this.keptFetchSignal = undefined;

          const newExtractedParams = extractParamsForKey(this.params);
          const newStorageKey = queryKeyFor(this.def, newExtractedParams);

          const paramsDidChange = newStorageKey !== this.storageKey;

          if (paramsDidChange) {
            this.adoptParams(newExtractedParams, newStorageKey);
          }

          this.getOrCreateExecutionContext();

          const configError = this.configError;
          if (configError !== undefined) {
            this.stopSubscription();
            this.rejectedByConfig = true;
            this.relayState.setError(configError as Error);
            return;
          }

          const recovering = this.rejectedByConfig;
          this.rejectedByConfig = false;

          if (!this.initialized) {
            this.queryClient.activateQuery(this);
            this.initialize();
          } else if (recovering) {
            if (wasPaused || activating) this.queryClient.activateQuery(this);
            this.reconcileSubscription();
            this.runDebounced();
          } else if (wasPaused || activating) {
            this.queryClient.activateQuery(this);

            if (activating && this.updatedAt !== undefined) {
              this.reconcileSubscription();
            }

            // If the relay shows pending but the abort controller is gone, the
            // previous fetch was aborted during deactivation (or never started).
            // runDebounced() would bail on the doomed promise. A rejected relay restarts
            // too, unless a stagger can re-settle its value and spread the refetch.
            if (
              this.abortedByDeactivation &&
              this.queryClient.reactivationStaggerMs > 0 &&
              !paramsDidChange &&
              !this.relayState.isPending
            ) {
              const value = this.relayState.value;
              if (value !== undefined) {
                this.abortedByDeactivation = false;
                this.relayState.value = value;
              }
            }
            if (
              (this.relayState.isPending && (this._abortController === undefined || paramsDidChange)) ||
              this.abortedByDeactivation
            ) {
              this.restartAbortedFetch();
            } else {
              const refreshStaleOnReconnect = this.config?.refreshStaleOnReconnect ?? true;
              // No grace after a reconnect: data may have been missed while offline.
              const withinGrace =
                activating &&
                !wasPaused &&
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
            if (this.startPending) {
              // The pending first start sends the new params.
            } else if (this.relayState.isPending) {
              // Replace the in-flight or queued fetch for the old params.
              this.restartAbortedFetch(true);
            } else {
              this.runDebounced(0, false, true);
            }
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
    const previousRoot = this.rootEntity;
    this.rootEntity = this.queryClient.parseAndApplyRootEntity(
      data,
      this._queryId,
      def.statics.shape,
      persist,
      appendMode,
      preloadedEntities,
    );

    if (previousRoot !== undefined && previousRoot !== this.rootEntity && !def.statics.isEntityResult) {
      this.queryClient.releaseQueryRoot(previousRoot, this);
    }

    // Attach extra methods and getters on first discovery
    if (this.rootEntity._extraMethods === undefined) {
      this.rootEntity._extraMethods = this._extraMethods;
      this.rootEntity._extraGetters = {
        __hasNext: () => this.hasNext,
        __isFetchingNext: () => this._fetchNextPromise !== undefined,
      };
      // Deliberately not notified: this query's consumers snapshot fresh via the
      // relay, and other consumers of a shared entity don't need these extras.
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
    const storageKey = this.storageKey;
    const fetchStarts = this.fetchStarts;

    try {
      loaded = this.queryClient.loadCachedQuery(this.def, storageKey);
    } catch (error) {
      this.discardCorruptCache(error, storageKey);
      loaded = undefined;
    }

    if (isThenable(loaded)) {
      loaded.then(
        cached => {
          if (this.stoppedByDestroy()) return;
          if (this.storageKey === storageKey) {
            this.hydrate(cached);
            this.startSubscriptionAndFetch();
          } else {
            this.startAfterParamsChangedDuringLoad(fetchStarts);
          }
        },
        error => {
          if (this.stoppedByDestroy()) return;
          this.discardCorruptCache(error, storageKey);
          if (this.storageKey === storageKey) {
            this.startSubscriptionAndFetch();
          } else {
            this.startAfterParamsChangedDuringLoad(fetchStarts);
          }
        },
      );
    } else {
      this.hydrate(loaded);
      this.startPending = true;
      this.queryClient.noteDeferredStart(this);
      queueMicrotask(this.runPendingStart);
    }
  }

  /** Drops a cache load for old params. Fetches unless the change already did. */
  private startAfterParamsChangedDuringLoad(fetchStartsAtLoad: number): void {
    if (this.fetchStarts === fetchStartsAtLoad) this.startSubscriptionAndFetch();
  }

  private runPendingStart = (): void => {
    this.runStart(true);
  };

  /** A microtask start races Signalium's flush, so a deactivation in it lets the fetch finish. */
  private runStart(fromMicrotask: boolean): void {
    if (!this.startPending) return;
    this.startPending = false;
    if (this.hasSignalParams) {
      // A Signal param set this task reaches update() only next flush. Read it now.
      const extractedParams = extractParamsForKey(this.params);
      const storageKey = queryKeyFor(this.def, extractedParams);
      if (storageKey !== this.storageKey) {
        this.adoptParams(extractedParams, storageKey);
        this.getOrCreateExecutionContext();
      }
    }
    const fetchesBefore = this.fetchStarts;
    this.startSubscriptionAndFetch();
    if (fromMicrotask && this.fetchStarts !== fetchesBefore) {
      this.firstFetchController = this._abortController;
      this.firstFetchWindow = openStartWindow();
    }
  }

  private adoptParams(extractedParams: Record<string, unknown> | undefined, storageKey: number): void {
    this.currentParams = extractedParams as QueryParams;
    this.storageKey = storageKey;
    this._queryId = extractedParams !== undefined ? hashValue(extractedParams) : 0;
    // The timestamp is the old params' data. Force a refetch.
    if (this.updatedAt !== undefined) this.updatedAt = 0;
  }

  /**
   * Runs any microtask-queued start now. Called by a lease outside its reactive read.
   * @internal
   */
  startPendingNow(): void {
    this.runStart(false);
    const run = this.pendingDebouncedRun;
    this.pendingDebouncedRun = undefined;
    run?.();
    this.pendingRestart?.();
  }

  private discardCorruptCache(error: unknown, storageKey: number = this.storageKey): void {
    const qc = this.queryClient;
    qc.deleteQuery(storageKey);
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
    if (this.stoppedByDestroy() || !this._isActive || this.isPaused || this.configError !== undefined) {
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
    if (!this._isActive || this.queryClient.destroyed) return;

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
      // `TopicQuery.getConfig.subscribe` hands this to its adapter, which calls
      // it on a topic event. Non-enumerable to stay out of `Object.keys(this)`.
      Object.defineProperty(this._executionCtx, '_notePush', { value: this.notePush, configurable: true });
      this._executionCtx.rawFetchNext = this.def.statics.rawFetchNext;
      // `TopicQuery.getConfig.subscribe` reads `_topicAdapter` from the ctx;
      // set it eagerly so subscribe/unsubscribe work on the cache-fresh and
      // pre-fulfilled paths where `send()` never runs.
      (this._executionCtx as unknown as Record<string, unknown>)._topicAdapter = this.queryClient.getAdapter(
        this.def.statics.adapterClass,
      );

      this._resolvedOptions = reactiveSignal(() => this.resolveOptionsSafely());
    }

    return this._executionCtx;
  }

  private async runQuery(): Promise<QueryResult<T>> {
    const def = this.def;

    if (this.isPaused) {
      throw new Error('Query is paused due to network status');
    }

    const ctx = this.getOrCreateExecutionContext();
    // A topic query's send() waits on its subscription, which deactivation may have torn down.
    this.reconcileSubscription();
    const adapter = this.queryClient.getAdapter(def.statics.adapterClass);
    const signal = this._abortController?.signal ?? new AbortController().signal;
    const attempt = this.attemptStatusTracker(ctx);
    const storageKey = this.storageKey;
    const fetchStart = this.fetchStarts;
    const destroyCount = this.destroyCount;

    try {
      const result = await withRetry(
        async () => {
          attempt.start();
          try {
            this.throwIfDestroyed();
            const freshData = await adapter.send(ctx, signal);
            // Params changed or client destroyed mid-request, and the adapter ignored the abort.
            if (this.storageKey !== storageKey || this.destroyCount !== destroyCount) throw abortError();
            this.throwIfDestroyed();
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
        attempt.options,
      );
      // An aborted fetch may have been replaced by one that failed.
      if (!signal.aborted) this.lastFetchFailed = false;
      // Not if a newer fetch's abort set it.
      if (this.fetchStarts === fetchStart) this.abortedByDeactivation = false;
      return result;
    } catch (error) {
      if (!signal.aborted) this.lastFetchFailed = true;
      if (signal === this.heldAbortSignal) {
        // Stay pending until reactivation or abortForDestroy() settles it.
        this.heldAbortSignal = undefined;
        return new Promise<never>(() => {});
      }
      throw error;
    } finally {
      if (signal === this.keptFetchSignal) {
        this.keptFetchSignal = undefined;
        if (!this._isActive) this.scheduleGc();
      }
    }
  }

  /**
   * Whether a pause's abort leaves the relay pending. Signalium keeps a rejected
   * relay's error until it gets a value, so the next activation would show it.
   */
  private holdsDeactivationAbort(): boolean {
    return this.relayState.value === undefined && this.config?.subscribe !== undefined;
  }

  private scheduleGc(): void {
    const gcTime = this.config?.gcTime ?? DEFAULT_GC_TIME;
    this.queryClient.gcManager.schedule(this.queryKey, gcTime, GcKeyType.Query);
  }

  /**
   * Replaces a fetch that a deactivation aborted, from inside the activating
   * read. The relay takes the new promise now so the doomed one can't settle
   * it. The subscription and request run adapter code, so they start outside
   * the read, on a microtask or when a lease starts them.
   */
  private restartAbortedFetch(afterFlush: boolean = false): void {
    this.fetchStarts++;
    this.parkedRestart = undefined;
    this.heldAbortSignal = undefined;
    if (this.abortedByDeactivation) {
      this.abortedByDeactivation = false;
      // Re-settle with the value. Signalium keeps the AbortError while pending again.
      const value = this.relayState.value;
      if (value !== undefined && !this.relayState.isPending) this.relayState.value = value;
    }
    this.cancelDebounced();
    this._abortController?.abort();
    this._fetchNextAbort?.abort();
    this._fetchNextAbort = undefined;
    this._fetchNextPromise = undefined;
    const controller = new AbortController();
    this._abortController = controller;

    let resolve!: (value: QueryResult<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<QueryResult<T>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const run = (): void => {
      if (this.pendingRestart !== run) return;
      this.pendingRestart = undefined;
      if (controller.signal.aborted || this.queryClient.destroyed) {
        reject(controller.signal.reason ?? abortError());
        return;
      }
      if (!this._isActive || this.isPaused) {
        // Went offline or inactive first. Park it until reconnect or deactivation.
        if (this._abortController === controller) this._abortController = undefined;
        this.parkedRestart = reject;
        return;
      }
      this.runQuery().then(resolve, reject);
    };
    this.pendingRestart = run;
    this.queryClient.noteDeferredStart(this);
    this.deferRun(run, afterFlush);
    this.relayState.setPromise(promise);
  }

  /** `afterFlush` waits for the pending flush, so a deactivation in it cancels the fetch first. */
  private deferRun(run: () => void, afterFlush: boolean): void {
    if (afterFlush) {
      // settled() may keep waiting on later flushes. The timer caps it at one task.
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;
      const once = (): void => {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
        run();
      };
      timer = setTimeout(once, 0);
      void settled().then(once);
    } else {
      queueMicrotask(run);
    }
  }

  private runQueryImmediately(): void {
    if (this.stoppedByDestroy()) return;
    this.fetchStarts++;
    this.abortedByDeactivation = false;
    this.parkedRestart = undefined;
    this.heldAbortSignal = undefined;
    this._abortController?.abort();
    this._abortController = new AbortController();
    this._fetchNextAbort?.abort();
    this._fetchNextAbort = undefined;
    this._fetchNextPromise = undefined;
    this.relayState.setPromise(this.runQuery());
  }

  /**
   * With no delay the fetch starts on a microtask (a zero timer can wait a frame on
   * React Native). `nextTask` forces a timer so a deactivation flush in the same
   * task can cancel the fetch instead of starting and aborting it.
   */
  private runDebounced(extraDelay: number = 0, nextTask: boolean = false, afterFlush: boolean = false): void {
    if (this.stoppedByDestroy() || this.relayState.isPending) return;

    const delay = (this.config?.debounce ?? 0) + extraDelay;

    this.cancelDebounced();

    if (delay > 0 || nextTask) {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = undefined;
        if (!this._isActive || this.isPaused) return;
        this.runQueryImmediately();
      }, delay);
      return;
    }

    const generation = this.debounceGeneration;
    const run = (): void => {
      if (generation !== this.debounceGeneration) return;
      this.debounceGeneration++;
      this.pendingDebouncedRun = undefined;
      // Deactivated or went offline meanwhile. Those paths decide what runs next.
      if (!this._isActive || this.isPaused) return;
      // Another path started a fetch in the meantime (refetch(), activation).
      if (this.relayState.isPending && this._abortController !== undefined) return;
      this.runQueryImmediately();
    };
    this.pendingDebouncedRun = run;
    this.queryClient.noteDeferredStart(this);
    this.deferRun(run, afterFlush);
  }

  private cancelDebounced(): void {
    this.debounceGeneration++;
    this.pendingDebouncedRun = undefined;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  /** Runs a task after queueing. Skipped if a fetch started since, rather than aborting and repeating it. */
  runReactivationRefetch(delay: number): void {
    if (!this._isActive || this.isPaused || this.relayState.isPending) return;
    const queuedAt = this.reactivationQueuedAt;
    if (this.fetchStarts !== queuedAt) return;

    const totalDelay = (this.config?.debounce ?? 0) + delay;
    if (totalDelay === 0) {
      this.runDebounced();
      return;
    }

    this.cancelDebounced();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (this.fetchStarts !== queuedAt) return;
      this.runQueryImmediately();
    }, totalDelay);
  }

  /**
   * On destroy or collection. Settles every awaiter, so nothing hangs or reaches the store.
   * @internal
   */
  abortForDestroy(): void {
    this.destroyCount++;
    this.cancelDebounced();
    this.stopSubscription();
    this.startPending = false;
    this.firstFetchController = undefined;
    this.keptFetchSignal = undefined;
    const controller = this._abortController;
    const inFlight = controller !== undefined && !controller.signal.aborted;
    controller?.abort();
    this._abortController = undefined;
    this._fetchNextAbort?.abort();
    this._fetchNextAbort = undefined;
    // Every awaiter must settle, including a pending relay whose start never ran.
    const restart = this.pendingRestart;
    restart?.();
    this.pendingRestart = undefined;
    const parked = this.parkedRestart;
    this.parkedRestart = undefined;
    parked?.(abortError());
    if (!inFlight && restart === undefined && parked === undefined && this._relayState?.isPending) {
      this._relayState.setError(abortError());
    }
  }

  /** After `destroy()`: starts nothing, and rejects a pending relay. */
  private stoppedByDestroy(): boolean {
    if (!this.queryClient.destroyed) return false;
    if (this._relayState?.isPending) this._relayState.setError(abortError());
    return true;
  }

  /** For an instance `destroy()` missed (collected, then read again). Aborting ends its retries too. */
  private throwIfDestroyed(): void {
    if (!this.queryClient.destroyed) return;
    this.abortForDestroy();
    throw abortError();
  }

  /** Records that the subscription delivered data. See `lastPushAt`. */
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
      this.runDebounced(0, true);
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
    if (this.rootEntity === undefined || !this._executionCtx || this.queryClient.destroyed) return false;
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
    const attempt = this.attemptStatusTracker(ctx);
    const storageKey = this.storageKey;
    const destroyCount = this.destroyCount;

    return withRetry(
      async () => {
        attempt.start();
        this.throwIfDestroyed();
        const freshData = await adapter.sendNext!(ctx, signal);
        if (this.storageKey !== storageKey || this.destroyCount !== destroyCount) throw abortError();
        this.throwIfDestroyed();
        this.updatedAt = Date.now();

        const result = this.applyData(freshData, true, true);
        this.saveQueryMetadata();

        return result;
      },
      this.retryConfig,
      signal,
      attempt.options,
    );
  }

  /**
   * Reports the status of `ctx.response` when the failed attempt set it, for a
   * REST error response whose body failed validation and so carries no status.
   */
  private attemptStatusTracker(ctx: Query): { start: () => void; options: WithRetryOptions } {
    const holder = ctx as unknown as { response?: unknown };
    let responseBefore: unknown;
    return {
      start: () => {
        responseBefore = holder.response;
      },
      options: {
        shouldRetry: this.queryClient.shouldRetry,
        getAttemptStatus: () =>
          holder.response !== responseBefore ? getFailedResponseStatus(holder.response) : undefined,
      },
    };
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
