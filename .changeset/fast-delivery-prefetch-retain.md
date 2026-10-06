---
'fetchium': minor
---

New `queryClient.prefetch(Query, params, { ttl })` and `queryClient.retain(fn, { ttl })` start queries before any component reads them. A component that mounts while one is held reuses its request and renders the data on its first render if it has arrived. Both return a `release` function; `prefetch` lasts 10 seconds by default and `retain` until released.

New `useSuspenseQuery` in `fetchium/react`. It suspends only while the query has no data yet, and sends a failed first fetch to the error boundary.

- A refetch without `debounce` starts on a microtask instead of after `setTimeout(0)`.
- Reading `.value` on a pending or failed query doesn't suspend or throw. The docs said it did.
