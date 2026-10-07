import { type Signal, isSignal as isSignalCheck } from 'signalium';
import { hashValue } from 'signalium/utils';
import { NetworkMode, RetryConfig, BaseUrlValue } from './types.js';
import { QueryDefinition } from './query.js';

// -----------------------------------------------------------------------------
// Query Types
// -----------------------------------------------------------------------------

/**
 * Reports whether the app is in the foreground. Supplied by the host (for
 * React Native, wrap `AppState`), since Fetchium cannot observe it itself.
 */
export interface ActivitySource {
  /** `true` while the app is foregrounded and background work should run. */
  isActive(): boolean;
  /** Calls `listener` whenever `isActive()` may have changed. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export interface QueryContext {
  log?: {
    error?: (message: string, error?: unknown) => void;
    warn?: (message: string, error?: unknown) => void;
    info?: (message: string) => void;
    debug?: (message: string) => void;
  };
  evictionMultiplier?: number;
  /** See `QueryClientConfig.activity`. */
  activity?: ActivitySource;
  /** See `QueryClientConfig.pollResumeJitterMs`. */
  pollResumeJitterMs?: number;
}

/**
 * Resolves a BaseUrlValue to a string.
 * Handles static strings, Signals, and functions.
 */
export function resolveBaseUrl(baseUrl: BaseUrlValue | undefined): string | undefined {
  if (baseUrl === undefined) return undefined;
  if (typeof baseUrl === 'string') return baseUrl;
  if (typeof baseUrl === 'function') return baseUrl();
  return baseUrl.value; // Signal
}

export interface QueryCacheOptions {
  maxCount?: number;
  cacheTime?: number; // minutes - on-disk/persistent storage expiration. Default: 1440 (24 hours)
}

export interface FetchNextConfig {
  /** Override the URL/path for the next page request. Can be a FieldRef (e.g. this.result.nextUrl). */
  url?: unknown;
  /** Search params for the next page. Values can be FieldRefs (e.g. this.result.nextCursor). */
  searchParams?: Record<string, unknown>;
}

export interface QueryConfigOptions {
  gcTime?: number; // minutes - in-memory eviction time. Default: 5. Use 0 for next-tick, Infinity to never GC.
  staleTime?: number; // milliseconds - how long data is considered fresh. Default: 0 (always stale)
  debounce?: number; // milliseconds - debounce delay for param-change refetches. Default: 0
  networkMode?: NetworkMode; // default: NetworkMode.Online
  retry?: RetryConfig | number | boolean; // default: 3 on client, 0 on server
  refreshStaleOnReconnect?: boolean; // default: true
  /**
   * Milliseconds. When the query reactivates (a watcher returns, or a paused
   * scope resumes) with data younger than this, it is not refetched even if
   * stale. Data a subscription pushed to counts as fresh from the last push.
   * Overrides `QueryClientConfig.reactivationGraceMs`. Does not affect network
   * reconnects, `refetch()`, or invalidation.
   */
  reactivationGraceMs?: number;
  subscribe?: (this: any, onEvent: (event: import('./types.js').MutationEvent) => void) => () => void;
}

export type QueryParams = Record<
  string,
  | string
  | number
  | boolean
  | undefined
  | null
  | Signal<string | number | boolean | undefined | null>
  | unknown[] // For body array params
  | Record<string, unknown> // For body object params
>;

// -----------------------------------------------------------------------------
// QueryStore Interface
// -----------------------------------------------------------------------------

export type PreloadedEntityMap = Map<number, Record<string, unknown>>;

export interface CachedQuery {
  value: unknown;
  refIds: Set<number> | undefined;
  updatedAt: number;
  preloadedEntities?: PreloadedEntityMap;
}

export interface QueryStore {
  loadQuery(queryDef: QueryDefinition<any, any, any>, queryKey: number): MaybePromise<CachedQuery | undefined>;

  saveQuery(
    queryDef: QueryDefinition<any, any, any>,
    queryKey: number,
    value: unknown,
    updatedAt: number,
    refIds?: Set<number>,
  ): void;

  saveEntity(entityKey: number, value: unknown, refIds?: Set<number>): void;

  /**
   * Writes the fields streamed events supplied for an entity built from them.
   * If the store holds a record for the key, it merges `fields` over it and
   * derives references from the merged value. Otherwise `fields` becomes the
   * record. Without this method the client calls `saveEntity` with the whole
   * in-memory data, which drops the fields the events did not carry.
   */
  mergeEntity?(entityKey: number, fields: unknown, refIds?: Set<number>): void;

  activateQuery(queryDef: QueryDefinition<any, any, any>, storageKey: number): void;

  deleteQuery(queryKey: number): void;

  purgeStaleQueries?(): MaybePromise<void>;

  /**
   * Called with the key of every record the store drops on its own (eviction,
   * cascade, purge). May return an unsubscribe function, which the client
   * calls from `destroy()`. A store without this hook is written on every
   * apply.
   */
  onDelete?(listener: (key: number) => void): void | (() => void);

  /**
   * For stores that process writes asynchronously: called with each entity
   * key once its write has been applied. The client then treats an entity as
   * persisted only after this acknowledgement, so a dropped write is retried.
   */
  onPersisted?(listener: (key: number) => void): void | (() => void);

  /**
   * For stores that process writes asynchronously: whether every operation
   * handed to the store has been processed. While it returns `false` the
   * client does not skip entity writes, since an operation still queued could
   * delete the record the skip relies on. Absent means always settled.
   */
  isSettled?(): boolean;

  /**
   * For stores that process writes asynchronously, a narrower `isSettled`:
   * whether an operation that could delete a record is still queued. The
   * client's own entity writes don't count, since it rewrites any entity whose
   * reference they drop. When present it replaces `isSettled`, so a burst of
   * entity writes doesn't disable write skipping for every other entity.
   */
  hasQueuedDeletes?(): boolean;

  /**
   * Whether the store holds a record for this entity key, or `undefined` if
   * it can't tell yet (it hasn't finished reading what it holds). A streamed
   * event for an entity not in memory refreshes the record only when this
   * returns `true`. Without this hook, such events are not written.
   */
  hasEntity?(key: number): boolean | undefined;
}

export type MaybePromise<T> = T | Promise<T>;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function isSignal(value: unknown): value is Signal<any> {
  return isSignalCheck(value);
}

export function extractParamsForKey(params: QueryParams | undefined): Record<string, unknown> | undefined {
  if (params === undefined) {
    return undefined;
  }

  const extracted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (isSignal(value)) {
      extracted[key] = value.value;
    } else {
      extracted[key] = value;
    }
  }

  return extracted;
}

/**
 * Computes the query key for instance lookup. Instance keys use raw params
 * (with Signals), storage keys use extracted params (Signal values read).
 */
export const queryKeyFor = (queryDef: QueryDefinition<any, any, any>, params: unknown): number => {
  return hashValue([queryDef.statics.id, params]);
};
