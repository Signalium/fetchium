import { type Signal, isSignal as isSignalCheck } from 'signalium';
import { hashValue } from 'signalium/utils';
import { NetworkMode, RetryConfig, BaseUrlValue } from './types.js';
import { QueryDefinition } from './query.js';

// -----------------------------------------------------------------------------
// Query Types
// -----------------------------------------------------------------------------

/** Host-supplied foreground state, e.g. wrapping React Native's `AppState`. */
export interface ActivitySource {
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
  // `activity` and `pollResumeJitterMs` reach the context undeclared: an app may
  // have augmented this interface with the same names.
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
  /** Ms. Overrides `QueryClientConfig.reactivationGraceMs` for this query. */
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
   * Writes the fields streamed events supplied, merged over the stored record
   * if one exists (references derived from the merged value). Without it the
   * client calls `saveEntity`, dropping fields the events did not carry.
   */
  mergeEntity?(entityKey: number, fields: unknown, refIds?: Set<number>): void;

  activateQuery(queryDef: QueryDefinition<any, any, any>, storageKey: number): void;

  deleteQuery(queryKey: number): void;

  purgeStaleQueries?(): MaybePromise<void>;

  /**
   * Called with the key of every record the store drops on its own (eviction,
   * cascade, purge). May return an unsubscribe, called from `destroy()`.
   * Without it, entities are written on every apply.
   */
  onDelete?(listener: (key: number) => void): void | (() => void);

  /**
   * Async stores: called with each entity key once its write is applied. The
   * client treats an entity as persisted only after this acknowledgement.
   */
  onPersisted?(listener: (key: number) => void): void | (() => void);

  /**
   * Async stores: whether every queued operation has been processed. While
   * `false` the client does not skip unchanged entity writes. Absent means
   * always settled.
   */
  isSettled?(): boolean;

  /**
   * Async stores: a narrower `isSettled` that ignores the client's own entity
   * writes, reporting only queued operations that could delete a record.
   * Takes precedence over `isSettled` when present.
   */
  hasQueuedDeletes?(): boolean;

  /**
   * Whether the store holds a record for this key, or `undefined` if it can't
   * tell yet. An event for an entity not in memory is written only when this
   * returns `true`.
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
