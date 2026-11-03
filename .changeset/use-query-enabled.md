---
'fetchium': minor
---

Add an `enabled` option to `useQuery`: `useQuery(Query, params, { enabled })`. It defaults to `true`. A disabled query never fetches or subscribes, but still reads the cache, like TanStack Query's `enabled: false`. With cached data, in memory or in the persistent store within `cacheTime`, it starts resolved with that data, even if stale. Without cached data it stays pending and sends no request. The cached value stays live: entity updates and fetches by enabled readers of the same query show up in it. Setting `enabled` to `true` activates the query with the current params, and doesn't refetch a cache that is still within `staleTime`. For queries without params, pass `undefined` as the second argument.
