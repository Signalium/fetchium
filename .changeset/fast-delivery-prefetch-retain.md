---
'fetchium': minor
---

Adds `queryClient.prefetch(QueryClass, params, { ttl })` and `queryClient.retain(fn, { ttl })`. Both keep queries active without a reader and return a `release` function. A reader that mounts while the lease is held joins the running query: no second request, and the data on its first render if it has arrived. `prefetch` defaults to a 10 s lease (`DEFAULT_PREFETCH_TTL`), an upper bound even with a fetch in flight; `retain` lasts until released.

Adds `useSuspenseQuery` to `fetchium/react`. It suspends only when the query has never produced a value (in memory or in a synchronous store), never for a refetch, and throws a failed cold fetch to the error boundary.

A refetch with no `debounce` (a stale query reactivating, a Signal param change) now starts on a microtask instead of after `setTimeout(0)`, which on React Native can wait a frame. Invalidation still waits a task, so a query whose last reader left in the same task is deactivated rather than refetched.

Docs no longer claim that reading `.value` on a pending or rejected query suspends or throws; it does neither.
