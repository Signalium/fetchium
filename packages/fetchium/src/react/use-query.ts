import { useMemo } from 'react';
import { useReactive } from 'signalium/react';
import { hashValue } from 'signalium/utils';
import { ExtractType, QueryPromise } from '../types.js';
import { fetchQuery, Query } from '../query.js';
import { HasRequiredKeys, Optionalize, Signalize } from '../type-utils.js';

/**
 * Dev-only counter, used by tests to verify that `useQuery` allocates one
 * stable thunk per (QueryClass, deeply-equal args) combination across renders
 * instead of a fresh thunk per render. Stripped from production builds via the
 * `IS_DEV` build-time constant.
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
  // The thunk identity must be stable across re-renders when args are deeply
  // equal. signalium's `useReactive` keys its internal `ReactiveDefinition` and
  // signal on the fn reference (WeakMap), so a fresh fn per render creates a
  // fresh signal per render. In React 18-style commit ordering (and any path
  // where unsubscribe of the old signal and subscribe of the new one straddle
  // a microtask flush), the relay loses its sole watcher to a deactivate
  // cascade with no rescue, even though a consumer is still mounted.
  //
  // The Signalium Babel preset's `useReactive` transform wraps the inline
  // thunk in `useCallback(fn, [QueryClass, args])`, but `args` is the rest
  // collection - a fresh array literal per call - so `Object.is` deps compare
  // false every render. Hash the args structurally so the memo key is stable
  // when values are deeply equal.
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
