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
  // `activity` and `pollResumeJitterMs` (see `QueryClientConfig`) reach the
  // context as pass-through keys, as any custom config key does, but are not
  // declared here: an app may have augmented this interface with its own
  // field of the same name. `poll()` checks their shape before using them.
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
   * scope resumes) and its data is younger than this, it is not refetched even
   * if stale. Data a subscription pushed to (a stream event, or a topic event
   * sent with its topic) counts as fresh from the last push. Overrides `QueryClientConfig.reactivationGraceMs`. Does
   * not affect network reconnects, `refetch()`, or invalidation.
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

  /**
   * Writes an entity's record. `rest`, when given, is a JSON object body
   * (`"a":1,"b":{…}`) of fields the record already held that no entity class
   * applied to the in-memory instance declares (another class sharing the
   * typename wrote them). The store writes them alongside `value`, ahead of
   * its fields, so the write does not drop them; `refIds` already includes
   * the references inside them. A store that ignores `rest` drops those
   * fields from the record, as before.
   */
  saveEntity(entityKey: number, value: unknown, refIds?: Set<number>, rest?: string): void;

  /**
   * Writes the fields streamed events supplied for an entity built from them:
   * a store that holds a record for the key merges `fields` over it (and
   * derives the record's references from the merged value); one that does not
   * writes `fields` as the record. A store without this method gets the
   * entity's whole in-memory data through `saveEntity` instead, which drops
   * from its record the fields the events did not carry.
   */
  mergeEntity?(entityKey: number, fields: unknown, refIds?: Set<number>): void;

  activateQuery(queryDef: QueryDefinition<any, any, any>, storageKey: number): void;

  deleteQuery(queryKey: number): void;

  purgeStaleQueries?(): MaybePromise<void>;

  /**
   * Called with the key of every record the store drops on its own (eviction,
   * cascade, purge). May return an unsubscribe function; the client calls it
   * from `destroy()`. A store without this hook is written on every apply.
   */
  onDelete?(listener: (key: number) => void): void | (() => void);

  /**
   * For stores that process writes asynchronously: called with the key of
   * every entity record once its write has actually been applied. While a
   * store offers this, the client treats an entity as persisted only after
   * the acknowledgement, so a write the store dropped is retried.
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
   * whether an operation that could delete a record is still queued. This
   * client's own entity writes do not count; for those that drop a
   * reference, the client itself writes the referenced entity again. When
   * present, the client uses it instead of `isSettled`, so a burst of entity
   * writes does not turn write skipping off for every other entity.
   */
  hasQueuedDeletes?(): boolean;

  /**
   * Whether the store currently holds a record for this entity key, or
   * `undefined` while it cannot tell yet (a store that has not finished
   * reading what it holds). A streamed event for an entity that is not in
   * memory refreshes the record only when this answers `true`; a store
   * without this hook is not written for such events.
   */
  hasEntity?(key: number): boolean | undefined;

  /**
   * Synchronous stores: the stored record of an entity, parsed, or
   * `undefined` when there is none. Read once, before the first write of an
   * entity whose record may hold fields of another class sharing its
   * typename (see `getEntityFieldNames`), so that write keeps them.
   */
  readEntity?(entityKey: number): Record<string, unknown> | undefined;

  /**
   * The top-level field names the entity classes of `typename` have
   * declared, as `addEntityFieldNames` recorded them in this session or an
   * earlier one. Lets the client tell, without reading any record, which
   * classes may be handed a record holding fields they do not declare. A
   * store without these methods only knows the classes of the current
   * session.
   */
  getEntityFieldNames?(typename: string): readonly string[] | undefined;
  /**
   * Called once per entity class and client with every top-level field the
   * class declares. A store may forget names no class has declared for a
   * while (`SyncQueryStore`: 30 days), so a field an app update removed stops
   * being kept in records.
   */
  addEntityFieldNames?(typename: string, fields: readonly string[]): void;
  /**
   * Whether the names `getEntityFieldNames` returns cover every class that
   * wrote a record the store holds. Asked once, when the client is created.
   * Only then is an entity built from streamed events that carried every
   * field of its class, of a typename whose other classes declare nothing
   * more, written whole rather than merged into its record. A store some of
   * whose records were written before it remembered field names (by an
   * earlier release) answers `false` until they cannot matter.
   */
  entityFieldNamesComplete?(): boolean;
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
