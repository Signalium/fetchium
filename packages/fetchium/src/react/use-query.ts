import { useMemo } from 'react';
import { ReactivePromise } from 'signalium';
import { useReactive } from 'signalium/react';
import { hashValue } from 'signalium/utils';
import { ExtractType, QueryPromise } from '../types.js';
import { fetchQuery, Query } from '../query.js';
import { HasRequiredKeys, Optionalize, Signalize } from '../type-utils.js';

type QueryArgs<T extends Query> =
  HasRequiredKeys<ExtractType<T['params']>> extends true
    ? [params: Optionalize<Signalize<ExtractType<T['params']>>>]
    : [params?: Optionalize<Signalize<ExtractType<T['params']>>> | undefined];

const disabledQuery = new ReactivePromise<never>();

/**
 * Dev-only counter exported for tests to assert thunk identity stability
 * across re-renders. Stripped from production builds via `IS_DEV`.
 */
export let __debug_thunkAllocations = 0;
export function __debug_resetThunkAllocations(): void {
  __debug_thunkAllocations = 0;
}

/**
 * React hook for fetching a query.
 *
 * Returns a structurally-shared deep snapshot of the query's `ReactivePromise`,
 * so memoized children that receive subtrees as props keep stable references
 * when the underlying data is unchanged. Implemented as a thin wrapper around
 * Signalium v3's `useReactive`, which is deep-by-default.
 * Pass `{ enabled: false }` as the third argument to return a pending result
 * without fetching or subscribing to the query. Defaults to enabled.
 */
export function useQuery<T extends Query>(
  QueryClass: new () => T,
  ...args: HasRequiredKeys<ExtractType<T['params']>> extends true
    ? [params: QueryArgs<T>[0], options?: { enabled?: boolean }]
    : [params?: QueryArgs<T>[0], options?: { enabled?: boolean }]
): QueryPromise<T> {
  const enabled = args[1]?.enabled ?? true;
  // Stabilize thunk identity across renders so signalium's `useReactive`
  // (keyed on fn identity via WeakMap) reuses the same signal. Without it,
  // React 18 / React Native commit ordering can flush a deactivate cascade
  // between unsubscribe-old and subscribe-new and tear down the relay while
  // a consumer is still mounted.
  const paramsHash = hashValue(args[0]);
  const thunk = useMemo(
    () => {
      if (IS_DEV) __debug_thunkAllocations++;
      return () => (enabled ? fetchQuery(QueryClass, ...([args[0]] as QueryArgs<T>)) : disabledQuery);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [QueryClass, paramsHash, enabled],
  );
  return useReactive(thunk) as QueryPromise<T>;
}
