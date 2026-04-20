import { getContext } from 'signalium';
import { ExtractType, TypeDef, TypeDefShape, RetryConfig, QueryPromise, Mask, QUERY_ID } from './types.js';
import {
  QueryCacheOptions,
  QueryConfigOptions,
  FetchNextConfig,
  QueryClientContext,
  QueryParams,
  queryKeyFor,
} from './QueryClient.js';
import { ValidatorDef, t } from './typeDefs.js';
import { HasRequiredKeys, Optionalize, Signalize } from './type-utils.js';
import {
  createDefinitionProxy,
  extractDefinition,
  createExecutionContext as createExecutionContextUtil,
  type CapturedDefinition,
} from './fieldRef.js';
import type { QueryAdapter, QueryAdapterClass } from './QueryAdapter.js';

// ================================
// Retry config
// ================================

export interface ResolvedRetryConfig {
  retries: number;
  retryDelay: (attempt: number) => number;
}

export function resolveRetryConfig(
  retryOption: RetryConfig | number | boolean | undefined,
  isServer: boolean = typeof window === 'undefined',
): ResolvedRetryConfig {
  let retries: number;

  if (retryOption === false) {
    retries = 0;
  } else if (retryOption === undefined || retryOption === true) {
    retries = isServer ? 0 : 3;
  } else if (typeof retryOption === 'number') {
    retries = retryOption;
  } else {
    retries = retryOption.retries;
  }

  const retryDelay =
    typeof retryOption === 'object' && retryOption.retryDelay
      ? retryOption.retryDelay
      : (attempt: number) => 1000 * Math.pow(2, attempt);

  return { retries, retryDelay };
}

// ================================
// Query base class
// ================================

export abstract class Query {
  static cache?: QueryCacheOptions;
  /**
   * The adapter class responsible for sending requests for this query type.
   * Must be set on each concrete Query subclass (or inherited from a base like RESTQuery).
   */
  static adapter?: QueryAdapterClass;

  params?: Record<string, TypeDef>;
  abstract result: TypeDefShape;
  config?: QueryConfigOptions;

  declare context: import('./query-types.js').QueryContext;
  declare refetch: () => void;
  declare resultData: Record<string, unknown>;
  declare rawFetchNext: FetchNextConfig | undefined;

  abstract getIdentityKey(): unknown;

  getConfig?(): QueryConfigOptions | undefined;

  constructor() {
    return createDefinitionProxy(this);
  }
}

// ================================
// Query definition
// ================================

const queryDefCache = new WeakMap<new () => Query, QueryDefinition<any, any, any>>();

export interface ResolvedQueryOptions {
  config: QueryConfigOptions | undefined;
  retryConfig: ResolvedRetryConfig;
}

export interface QueryDefinitionStatics {
  readonly id: string;
  /** Root entity shape. For non-entity results this is a synthetic EntityDef
   *  with QUERY_ID as idField. For entity results this is the entity's own
   *  ValidatorDef. */
  readonly shape: ValidatorDef<unknown>;
  readonly cache: QueryCacheOptions | undefined;
  /** Raw fetchNext config with unresolved FieldRefs, extracted before reification. */
  readonly rawFetchNext: FetchNextConfig | undefined;
  /** Whether the adapter implements sendNext(). */
  readonly hasSendNext: boolean;
  /** Whether the result shape is already an entity (vs synthetic wrapper). */
  readonly isEntityResult: boolean;
  /** The adapter class responsible for sending requests. */
  readonly adapterClass: QueryAdapterClass;
}

export class QueryDefinition<Params extends QueryParams | undefined, Result, StreamType> {
  readonly statics: QueryDefinitionStatics;

  constructor(
    statics: QueryDefinitionStatics,
    public readonly captured: CapturedDefinition<Query>,
  ) {
    this.statics = statics;
  }

  createExecutionContext(
    actualParams: Record<string, unknown>,
    queryContext: import('./query-types.js').QueryContext,
  ): Query {
    return createExecutionContextUtil(this.captured, actualParams, queryContext);
  }

  resolveOptions(ctx: Query): ResolvedQueryOptions {
    const { methods } = this.captured;

    const config = methods.getConfig ? methods.getConfig.call(ctx) : ctx.config;
    const retryConfig = resolveRetryConfig(config?.retry);

    return { config, retryConfig };
  }

  static for(QueryClass: new () => Query): QueryDefinition<any, any, any> {
    let queryDefinition = queryDefCache.get(QueryClass);

    if (queryDefinition !== undefined) {
      return queryDefinition;
    }

    const instance = new QueryClass();
    const captured = extractDefinition(instance);

    const id = String(captured.methods.getIdentityKey.call(captured.fields));
    const resultDef = captured.fields.result;
    const shape =
      resultDef instanceof ValidatorDef
        ? (resultDef as ValidatorDef<unknown>)
        : (t.object(resultDef) as unknown as ValidatorDef<unknown>);
    const isEntityResult = (shape.mask & Mask.ENTITY) !== 0;
    const cache = (QueryClass as typeof Query).cache;

    // Extract raw fetchNext config before reification so FieldRefs survive
    const rawFetchNext = (captured.fields as unknown as Record<string, unknown>).fetchNext as
      | FetchNextConfig
      | undefined;

    // Resolve the adapter class from the Query class static property
    const adapterClass = (QueryClass as typeof Query).adapter;
    if (!adapterClass) {
      throw new Error(
        `Query class "${QueryClass.name}" must define a static \`adapter\` property. ` +
          `Extend RESTQuery (from fetchium/rest) or set \`static adapter = MyAdapter\` on your query class.`,
      );
    }

    // Derive hasSendNext from the adapter prototype
    const hasSendNext = typeof adapterClass.prototype.sendNext === 'function';

    // For entity results, the root entity IS the result entity.
    // For non-entity results, create a synthetic EntityDef with QUERY_ID as idField.
    const rootEntityShape = isEntityResult
      ? shape
      : new ValidatorDef(
          Mask.ENTITY | Mask.OBJECT,
          shape.shape,
          undefined,
          undefined,
          id, // typenameValue — unique per query class
          QUERY_ID, // idField — symbol, injected onto payload before parse
        );

    queryDefinition = new QueryDefinition(
      { id, shape: rootEntityShape, cache, rawFetchNext, hasSendNext, isEntityResult, adapterClass },
      captured,
    );

    queryDefCache.set(QueryClass, queryDefinition);
    return queryDefinition;
  }
}

// ================================
// Type extraction from Query classes
// ================================

export type ExtractQueryParams<T extends Query> =
  T['params'] extends Record<string, TypeDef>
    ? { [K in keyof T['params']]: ExtractType<T['params'][K]> }
    : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
      {};

// ================================
// Query definition lookup
// ================================

export const queryKeyForClass = (cls: new () => Query, params: unknown): number => {
  const queryDef = QueryDefinition.for(cls);
  return queryKeyFor(queryDef, params);
};

export function getQueryDefinition(QueryClass: new () => Query): QueryDefinition<any, any, any> {
  return QueryDefinition.for(QueryClass);
}

// ================================
// Public API
// ================================

export function fetchQuery<T extends Query>(
  QueryClass: new () => T,
  ...args: HasRequiredKeys<ExtractType<T['params']>> extends true
    ? [params: Optionalize<Signalize<ExtractType<T['params']>>>]
    : [params?: Optionalize<Signalize<ExtractType<T['params']>>> | undefined]
): QueryPromise<T> {
  const queryDef = QueryDefinition.for(QueryClass);

  const queryClient = getContext(QueryClientContext);

  if (queryClient === undefined) {
    throw new Error('QueryClient not found');
  }

  const params = args[0] as QueryParams | undefined;

  return queryClient.getQuery(queryDef, params);
}
