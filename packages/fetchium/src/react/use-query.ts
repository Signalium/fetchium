import { useReactive } from 'signalium/react';
import { ExtractType, QueryPromise } from '../types.js';
import { fetchQuery, Query } from '../query.js';
import { HasRequiredKeys, Optionalize, Signalize } from '../type-utils.js';

/**
 * React hook for fetching a query.
 *
 * Returns a structurally-shared deep snapshot of the query's `ReactivePromise`,
 * so memoized children that receive subtrees as props keep stable references
 * when the underlying data is unchanged. Implemented as a thin wrapper around
 * Signalium v3's `useReactive`, which is deep-by-default.
 */
export function useQuery<T extends Query>(
  QueryClass: new () => T,
  ...args: HasRequiredKeys<ExtractType<T['params']>> extends true
    ? [params: Optionalize<Signalize<ExtractType<T['params']>>>]
    : [params?: Optionalize<Signalize<ExtractType<T['params']>>> | undefined]
): QueryPromise<T> {
  return useReactive(() => fetchQuery(QueryClass, ...args)) as QueryPromise<T>;
}
