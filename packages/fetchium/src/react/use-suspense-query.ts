import { useEffect } from 'react';
import type { ReadyReactivePromise } from 'signalium';
import { useContext } from 'signalium/react';
import { ExtractType, QueryResult } from '../types.js';
import { Query, QueryDefinition } from '../query.js';
import { QueryClientContext, type QueryParams } from '../QueryClient.js';
import { HasRequiredKeys, Optionalize, Signalize } from '../type-utils.js';
import { useQuery } from './use-query.js';

/**
 * `useQuery` for components rendered under a React `<Suspense>` boundary.
 *
 * Suspends only on a cold miss: the query has never produced a value, neither
 * in memory nor (with a synchronous store) in the persisted cache. Anything
 * else renders immediately, including a stale value whose refetch is in
 * flight; refetches never suspend. A cold fetch that fails is thrown to the
 * nearest error boundary; resetting the boundary retries it.
 *
 * Changing params to ones with no value yet is a cold miss, so it suspends.
 * Wrap the change in `startTransition` to keep showing the previous result.
 *
 * Call it from a plain function component. Like `useQuery`, it can't run
 * inside a Signalium `component()` (that is a reactive context), where
 * `fetchQuery` is the way to read queries.
 */
export function useSuspenseQuery<T extends Query>(
  QueryClass: new () => T,
  ...args: HasRequiredKeys<ExtractType<T['params']>> extends true
    ? [params: Optionalize<Signalize<ExtractType<T['params']>>>]
    : [params?: Optionalize<Signalize<ExtractType<T['params']>>> | undefined]
): ReadyReactivePromise<QueryResult<T>> {
  const client = useContext(QueryClientContext);

  if (client === undefined) {
    throw new Error('QueryClient not found');
  }

  // Decide before useQuery: a render that suspends is discarded without a
  // commit, so a subscription taken by it would never be cleaned up. The
  // client holds the query active while suspended instead.
  const { promise, failed, error, key } = client.suspendOnColdMiss(
    QueryDefinition.for(QueryClass),
    args[0] as QueryParams | undefined,
  );

  if (failed) {
    throw error;
  }

  if (promise !== undefined) {
    throw promise;
  }

  const result = useQuery(QueryClass, ...args);

  // useQuery's subscription now keeps the query active.
  useEffect(() => {
    client.releaseSuspenseHold(key);
  }, [client, key]);

  return result as ReadyReactivePromise<QueryResult<T>>;
}
