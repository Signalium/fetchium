import { useMemo } from 'react';
import { useReactive } from 'signalium/react';
import { hashValue } from 'signalium/utils';
import { ExtractType, QueryPromise } from '../types.js';
import { fetchQuery, Query } from '../query.js';
import { HasRequiredKeys, Optionalize, Signalize } from '../type-utils.js';

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
 */
export function useQuery<T extends Query>(
  QueryClass: new () => T,
  ...args: HasRequiredKeys<ExtractType<T['params']>> extends true
    ? [params: Optionalize<Signalize<ExtractType<T['params']>>>]
    : [params?: Optionalize<Signalize<ExtractType<T['params']>>> | undefined]
): QueryPromise<T> {
  // Stabilize thunk identity across renders so signalium's `useReactive`
  // (keyed on fn identity via WeakMap) reuses the same signal. Without it,
  // React 18 / React Native commit ordering can flush a deactivate cascade
  // between unsubscribe-old and subscribe-new and tear down the relay while
  // a consumer is still mounted. The Babel preset's
  // `useCallback(fn, [QueryClass, args])` is a no-op here because `args` is
  // a fresh rest array per call.
  const paramsHash = hashValue(args);
  const thunk = useMemo(
    () => {
      if (IS_DEV) __debug_thunkAllocations++;
      return () => fetchQuery(QueryClass, ...args);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [QueryClass, paramsHash],
  );
  return useReactive(thunk) as QueryPromise<T>;
}
