import { useEffect } from 'react';
import type { ReadyReactivePromise } from 'signalium';
import { useContext } from 'signalium/react';
import { ExtractType, QueryResult } from '../types.js';
import { Query, QueryDefinition } from '../query.js';
import { QueryClientContext, type QueryParams } from '../QueryClient.js';
import { HasRequiredKeys, Optionalize, Signalize } from '../type-utils.js';
import { useQuery } from './use-query.js';

/**
 * `useQuery` under a `<Suspense>` boundary. Suspends only on a cold miss (no
 * value in memory or a sync store), never on refetch. A failed cold fetch is
 * thrown to the error boundary. Wrap param changes in `startTransition` to keep
 * the previous result. Not usable inside a Signalium `component()`.
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

  // Before useQuery: a suspended render never commits, so its subscription would leak.
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
