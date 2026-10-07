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

/**
 * The start window: open from when a query's first fetch starts on its
 * microtask until the Signalium flush outstanding at that moment has run. A
 * query mounted and unmounted in one task is deactivated by that flush after
 * its first fetch went out. A first fetch started inside the window is left
 * to finish instead of being aborted into an error. One window serves every
 * first fetch started before it closes.
 */
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
  /** `networkManager.reconnects` at the last deactivation. */
  private reconnectsAtDeactivate: number = 0;
  private currentParams: QueryParams | undefined = undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  /**
   * Bumped to schedule or cancel a zero-delay refetch, which runs on a
   * microtask and so can't be cleared like a timer.
   */
  private debounceGeneration: number = 0;
  /** The zero-delay refetch runDebounced() queued, until it runs or is cancelled. */
  private pendingDebouncedRun: (() => void) | undefined = undefined;
  /** initialize() queued startSubscriptionAndFetch() on a microtask that hasn't run yet. */
  private startPending: boolean = false;
  /** The fetch restartAbortedFetch() queued on a microtask, until it runs. */
  private pendingRestart: (() => void) | undefined = undefined;
  /**
   * Rejects a restart that found the query offline or inactive when it ran.
   * The relay stays pending until reconnecting restarts it or a full
   * deactivation rejects it.
   */
  private parkedRestart: ((error: unknown) => void) | undefined = undefined;
  /**
   * Signal of a first fetch that a same-task unmount let finish. GC is
   * scheduled once it settles: collecting earlier would leave the fetch
   * applying to an instance nothing owns.
   */
  private keptFetchSignal: AbortSignal | undefined = undefined;
  /**
   * Signal of a fetch whose abort leaves the relay pending instead of
   * rejecting it. See `holdsDeactivationAbort()`.
   */
  private heldAbortSignal: AbortSignal | undefined = undefined;
  /** Some param is a Signal, so its value can change before the first start runs. */
  private hasSignalParams: boolean = false;
  /** The first fetch's controller and its start window. See `openStartWindow()`. */
  private firstFetchController: AbortController | undefined = undefined;
  /** Bumped by `abortForDestroy()`, so a late response from before it is dropped. */
  private destroyCount: number = 0;
  private firstFetchWindow: number = 0;
  /**
   * A deactivation aborted the in-flight fetch, so the relay settles with an
   * AbortError. The next activation refetches instead of showing it.
   */
  private abortedByDeactivation: boolean = false;
  /** The last fetch ended in an error (not an abort). Disables the reactivation grace. */
  private lastFetchFailed: boolean = false;
  /**
   * When the subscription last pushed data (a stream event, or a topic event
   * for this query's topic). The reactivation grace measures from here when
   * it is later than `updatedAt`. poll() delivers by refetching, so it moves
   * `updatedAt` instead. A running subscription alone proves nothing: a poll
   * that hasn't ticked, or one stopped in the background, kept nothing current.
   */
  private lastPushAt: number | undefined = undefined;
  /** Bumped by every fetch or fetchNext start. A queued reactivation refetch uses it to detect it was overtaken. */
  private fetchStarts: number = 0;
  /** `fetchStarts` when the pending reactivation refetch was queued. */
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

  /**
   * Query id injected as QUERY_ID on non-entity payloads. It keys the root
   * entity and follows the params, so each params key's cached record points
   * at its own data.
   */
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
          // Cancel initialize()'s start if it hasn't run. The next activation restarts it.
          this.startPending = false;

          const controller = this._abortController;
          if (controller !== undefined && !controller.signal.aborted) {
            // A fetch may be waiting on the subscription this deactivation
            // tears down (a topic query's send() resolves from it), so it is
            // aborted and the next activation restarts it.
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

          // A restart parked while offline has no fetch to abort. Settle it as
          // the abort would have. The next activation restarts it.
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

          if (!this.initialized) {
            this.queryClient.activateQuery(this);
            this.initialize();
          } else if (wasPaused || activating) {
            this.queryClient.activateQuery(this);

            if (activating && this.updatedAt !== undefined) {
              this.reconcileSubscription();
            }

            // If the relay shows pending but the abort controller is gone, the
            // previous fetch was aborted during deactivation (or never started).
            // runDebounced() would bail out because isPending is still true from
            // the doomed promise, which may also never settle (a topic query's
            // send() waits on a subscription that is gone). A relay the abort
            // already rejected is restarted too, so it doesn't show the
            // AbortError until a refetch lands. So is a fetch still in flight
            // for params that changed meanwhile. With reactivationStaggerMs, a
            // rejected relay that holds a value is re-settled with it and
            // refetches like any stale relay below, so aborted refetches are
            // still spread across the window.
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
              // The grace covers a relay resuming, not a network reconnect: data
              // may have been missed while offline, even while inactive.
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
              // A fetch for the old params is in flight (or queued): replace it.
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
      // The params changed, so this query no longer shows the old params' root.
      this.queryClient.releaseQueryRoot(previousRoot, this);
    }

    // Attach extra methods and getters on first discovery
    if (this.rootEntity._extraMethods === undefined) {
      this.rootEntity._extraMethods = this._extraMethods;
      this.rootEntity._extraGetters = {
        __hasNext: () => this.hasNext,
        __isFetchingNext: () => this._fetchNextPromise !== undefined,
      };
      // The entity's key set changed, but consumers are deliberately not
      // notified. This query's consumers get the proxy through the relay and
      // snapshot it fresh, and other consumers of a shared entity have no use
      // for this query's extras. Notifying would re-run them all and change
      // their snapshot identity for unchanged data.
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
   * Runs once, from the relay's first activation, inside the read that watched
   * the relay (for React, during render).
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
   *
   * A lease (`retain()` / `prefetch()`) skips the microtask: it calls
   * startPendingNow() after its activating read, so the request goes out ahead
   * of any render already queued.
   */
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
          if (this.storageKey === storageKey) {
            this.hydrate(cached);
            this.startSubscriptionAndFetch();
          } else {
            this.startAfterParamsChangedDuringLoad(fetchStarts);
          }
        },
        error => {
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

  /**
   * A Signal param changed while an async cache load was pending. The loaded
   * entry belongs to the old params, so it is dropped, and a fetch starts
   * unless the change already started one.
   */
  private startAfterParamsChangedDuringLoad(fetchStartsAtLoad: number): void {
    if (this.fetchStarts === fetchStartsAtLoad) this.startSubscriptionAndFetch();
  }

  private runPendingStart = (): void => {
    this.runStart(true);
  };

  /**
   * `fromMicrotask` means the start raced Signalium's flush, so a deactivation
   * in that flush lets the fetch finish. A lease's start (`startPendingNow()`)
   * doesn't race: the lease holds the query, and releasing it aborts the fetch.
   */
  private runStart(fromMicrotask: boolean): void {
    if (!this.startPending) return;
    this.startPending = false;
    if (this.hasSignalParams) {
      // A Signal param set in the same task as the activation reaches update()
      // only in Signalium's next flush. Send the params as they are now.
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

  /** Switches to new params. Data shown until the next fetch lands is the old params'. */
  private adoptParams(extractedParams: Record<string, unknown> | undefined, storageKey: number): void {
    this.currentParams = extractedParams as QueryParams;
    this.storageKey = storageKey;
    this._queryId = extractedParams !== undefined ? hashValue(extractedParams) : 0;
    // The timestamp belongs to the old params' data, so force a refetch as invalidation does.
    if (this.updatedAt !== undefined) this.updatedAt = 0;
  }

  /**
   * Runs now any start that initialize(), a zero-delay runDebounced() or
   * restartAbortedFetch() queued on a microtask, which then does nothing.
   * Called by a lease after its activating read, outside any reactive
   * computation.
   *
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
    qc.store.deleteQuery(storageKey);
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
      // The data was never applied, so drop its timestamp and let the query fetch.
      this.updatedAt = undefined;
      this.discardCorruptCache(error);
    }
  }

  /** Starts the subscription, then the first fetch if there is no fresh cached value. */
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
      // `TopicQuery.getConfig.subscribe` hands this to its adapter, which calls
      // it when it delivers an event for the query's topic. Non-enumerable so
      // it stays out of `Object.keys(this)` inside query methods.
      Object.defineProperty(this._executionCtx, '_notePush', { value: this.notePush, configurable: true });
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
    // Restore a subscription that a deactivation or pause tore down: a topic
    // query's send() waits for data its subscription brings.
    this.reconcileSubscription();
    const adapter = this.queryClient.getAdapter(def.statics.adapterClass);
    const signal = this._abortController?.signal ?? new AbortController().signal;
    const attempt = this.attemptStatusTracker(ctx);
    const storageKey = this.storageKey;
    const destroyCount = this.destroyCount;

    try {
      const result = await withRetry(
        async () => {
          attempt.start();
          try {
            const freshData = await adapter.send(ctx, signal);
            // The adapter ignored the abort and the params changed, or the
            // client was destroyed, while the request was in flight.
            if (this.storageKey !== storageKey || this.destroyCount !== destroyCount) throw abortError();
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
      // An adapter that ignored the deactivation's abort delivered anyway.
      this.abortedByDeactivation = false;
      return result;
    } catch (error) {
      if (!signal.aborted) this.lastFetchFailed = true;
      if (signal === this.heldAbortSignal) {
        // Stay pending until the next activation replaces this fetch, or
        // abortForDestroy() settles it on collection or destroy.
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
   * Whether a deactivation that aborts this query's fetch leaves the relay
   * pending instead of rejecting it. Signalium keeps a rejected relay's error
   * until it gets a value, so the next mount would report `isRejected` with
   * the AbortError until its refetch lands (a chart switched away from
   * mid-fetch and back would flash its error state). A held relay is settled
   * by the next activation's refetch, or by `abortForDestroy()`.
   *
   * An unmount mid-fetch holds any query whose relay has no value yet, except
   * one mounted and unmounted in the same task: that is a one-off read, and
   * its awaiter gets the AbortError at once. A pause (offline) or a restart
   * parked while offline waits on the network, not a remount, so it uses this
   * method and holds only a query with a subscription, since a topic query's
   * fetch waits on the subscription the deactivation tears down. Other
   * awaiters get the AbortError at once.
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
      // The abort rejected the relay. Signalium keeps a rejected relay's
      // error while it is pending again, so the refetch would show the
      // AbortError next to the cached value. Re-settling with the value
      // clears it.
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
      if (controller.signal.aborted) {
        reject(controller.signal.reason ?? abortError());
        return;
      }
      if (!this._isActive || this.isPaused) {
        // Went offline or inactive before it ran. Park it with the relay
        // pending: reconnecting restarts it, and a full deactivation first
        // rejects it.
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

  /**
   * Queues a deferred fetch on a microtask or, with `afterFlush`, after
   * Signalium's outstanding flush. A params change reaches update() inside
   * that flush, which may also deactivate the query. Waiting for it costs no
   * extra task and lets the deactivation cancel the fetch instead of aborting
   * it after it went out.
   */
  private deferRun(run: () => void, afterFlush: boolean): void {
    if (afterFlush) {
      // settled() also waits for later flushes, which a listener that writes
      // signals can keep scheduling, so the timer caps the wait at one task.
      // A flush finishes within the task it starts in, so the timer still
      // fires after the outstanding one.
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
   * Starts a refetch after the query's `debounce` (plus `extraDelay`). Calls
   * made before it starts are coalesced into one fetch.
   *
   * With no delay the fetch starts on a microtask, not a timer. It still runs
   * outside the reactive computation that asked for it and still coalesces
   * calls from the same task, without waiting a macrotask (on React Native a
   * zero timer can wait up to a frame).
   *
   * `nextTask` keeps the zero-delay fetch on a timer. Invalidation uses it: a
   * query invalidated in the task its last watcher left stays active until
   * Signalium's deactivation flush, and the timer lets that flush cancel the
   * fetch instead of starting and aborting it.
   */
  private runDebounced(extraDelay: number = 0, nextTask: boolean = false, afterFlush: boolean = false): void {
    if (this.relayState.isPending) return;

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
      // Deactivated or went offline in the same task. Deactivation or
      // reconnecting decides what happens next.
      if (!this._isActive || this.isPaused) return;
      // Another path started a fetch in the meantime (refetch(), activation).
      if (this.relayState.isPending && this._abortController !== undefined) return;
      this.runQueryImmediately();
    };
    this.pendingDebouncedRun = run;
    this.queryClient.noteDeferredStart(this);
    this.deferRun(run, afterFlush);
  }

  /** Cancels a refetch scheduled by runDebounced(). */
  private cancelDebounced(): void {
    this.debounceGeneration++;
    this.pendingDebouncedRun = undefined;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  /**
   * Starts a reactivation refetch after `delay` plus the query's debounce.
   * The stagger flush calls this a task after queueing, so it rechecks that
   * the query is still active. Any fetch started since queueing (`refetch()`,
   * a poll tick, an invalidation) makes it redundant, so it is skipped rather
   * than aborting and repeating that fetch.
   */
  runReactivationRefetch(delay: number): void {
    if (!this._isActive || this.isPaused || this.relayState.isPending) return;
    const queuedAt = this.reactivationQueuedAt;
    if (this.fetchStarts !== queuedAt) return;

    const totalDelay = (this.config?.debounce ?? 0) + delay;
    if (totalDelay === 0) {
      // Within the flush task, on runDebounced()'s microtask.
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
   * Called by `QueryClient.destroy()` and when the client collects the query.
   * Aborts in-flight fetches (including a first fetch a same-task unmount
   * kept), cancels deferred ones and settles the relay, so nothing reaches
   * the store afterwards and no awaiter hangs.
   *
   * @internal
   */
  abortForDestroy(): void {
    this.destroyCount++;
    this.cancelDebounced();
    this.startPending = false;
    this.firstFetchController = undefined;
    this.keptFetchSignal = undefined;
    const controller = this._abortController;
    const inFlight = controller !== undefined && !controller.signal.aborted;
    controller?.abort();
    this._abortController = undefined;
    this._fetchNextAbort?.abort();
    this._fetchNextAbort = undefined;
    // Every awaiter must get an answer. A queued restart sees its aborted
    // controller and rejects, a parked one is rejected here, and an in-flight
    // fetch rejects with its abort. A pending relay with no fetch at all (its
    // first start never ran) is rejected directly.
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
    const attempt = this.attemptStatusTracker(ctx);
    const storageKey = this.storageKey;
    const destroyCount = this.destroyCount;

    return withRetry(
      async () => {
        attempt.start();
        const freshData = await adapter.sendNext!(ctx, signal);
        // As in runQuery().
        if (this.storageKey !== storageKey || this.destroyCount !== destroyCount) throw abortError();
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
   * Retry options that report a failed attempt's HTTP status. RESTQueryAdapter
   * sets `ctx.response` before parsing and validating the body, so an error
   * response with an invalid body throws a schema error that carries no
   * status. Only a response assigned during the failed attempt counts.
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
    // Never loaded, or invalidated (`markStale()`), whatever the staleTime.
    if (this.updatedAt === undefined || this.updatedAt === 0) {
      return true;
    }

    const staleTime = this.config?.staleTime ?? 0;
    return Date.now() - this.updatedAt >= staleTime;
  }

  /**
   * Data is younger than the reactivation grace and the last fetch didn't
   * fail. Pushed data counts from its last push. Invalidation (`updatedAt = 0`)
   * always falls outside.
   */
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
