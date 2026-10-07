---
'fetchium': minor
---

- New `queryClient.prefetch(Query, params, { ttl })` and `queryClient.retain(fn, { ttl })` start queries before a component reads them. A component that mounts meanwhile reuses the request.
- New `useSuspenseQuery` in `fetchium/react`. It suspends only while the query has no value.
- Refetches without `debounce` start on a microtask instead of after `setTimeout(0)`.
