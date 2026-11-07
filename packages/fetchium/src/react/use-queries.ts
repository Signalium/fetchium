import { useMemo } from 'react';
import { useReactive } from 'signalium/react';
import { hashValue } from 'signalium/utils';
import { ExtractType, QueryPromise } from '../types.js';
import { fetchQuery, getQueryDefinition, peekQuery, Query } from '../query.js';
import { HasRequiredKeys, Optionalize, Signalize } from '../type-utils.js';

type QueryParamsOf<T extends Query> = Optionalize<Signalize<ExtractType<T['params']>>>;

/**
 * Dev-only counter exported for tests to assert thunk identity stability
 * across re-renders. Stripped from production builds via `IS_DEV`.
 */
export let __debug_queriesThunkAllocations = 0;
export function __debug_resetQueriesThunkAllocations(): void {
  __debug_queriesThunkAllocations = 0;
}

/** One entry of `useQueries`: the same query, params and options `useQuery` takes. */
export type QueriesEntry<T extends Query> = {
  query: new () => T;
  enabled?: boolean;
} & (HasRequiredKeys<ExtractType<T['params']>> extends true
  ? { params: QueryParamsOf<T> }
  : { params?: QueryParamsOf<T> | undefined });

type EntryQuery<E> = E extends { query: new () => infer T extends Query } ? T : never;

/** Checks each entry's params against its own query. */
type CheckedEntries<E extends readonly unknown[]> = { [K in keyof E]: QueriesEntry<EntryQuery<E[K]>> };

/** One result per entry, in order. */
export type QueriesResults<E extends readonly unknown[]> = { -readonly [K in keyof E]: QueryPromise<EntryQuery<E[K]>> };

/**
 * `useQuery` for a list of queries whose length or contents vary between
 * renders. Returns one result per entry, in order, each shaped like
 * `useQuery`'s. An entry whose query and params are unchanged keeps its result
 * identity, so memoized children re-render only for the entries that changed.
 * An entry with `enabled: false` behaves as in `useQuery`: it never fetches or
 * subscribes, and shows cached data when there is some. A removed entry is
 * released like an unmounted `useQuery`.
 *
 * ```tsx
 * const users = useQueries(ids.map(id => ({ query: GetUser, params: { id } })));
 * ```
 */
export function useQueries<const E extends readonly { query: new () => Query }[]>(
  entries: E & CheckedEntries<E>,
): QueriesResults<E> {
  const list = entries as readonly QueriesEntry<Query>[];
  // Keyed on content, not the array, so a new array with the same entries
  // keeps the thunk (and every query's subscription) across renders.
  const key = hashValue(
    list.map(entry => {
      return [getQueryDefinition(entry.query).statics.id, entry.params, entry.enabled ?? true];
    }),
  );
  const thunk = useMemo(
    () => {
      if (IS_DEV) {
        __debug_queriesThunkAllocations++;
      }
      return () => {
        return list.map(entry => {
          if (entry.enabled ?? true) {
            return fetchQuery(entry.query, entry.params as QueryParamsOf<Query>);
          } else {
            return peekQuery(entry.query, entry.params as QueryParamsOf<Query>);
          }
        });
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return useReactive(thunk) as unknown as QueriesResults<E>;
}
