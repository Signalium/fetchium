---
'fetchium': patch
---

Fixes for snapshots, unchanged-data skipping and streamed-event writes.

- Development builds freeze snapshots, so mutating a query result (a `sort()` in render, an assignment) throws a `TypeError` where it happens. Production snapshots are not frozen; treat them as read-only. Fetchium no longer mutates objects you pass it, such as a snapshot handed back in a mutation's `effects`.
- In development, the stale-snapshot check reports through the client's `log.error` and an uncaught error (a red box on React Native) instead of throwing during a snapshot, which stopped every other consumer from updating.
- Mounting a second query whose entities are already in memory no longer leaves the first query's consumers with stale data. The in-memory data is used when it fits the new query's shape; otherwise the cached query is dropped and fetched instead of rendering with an item missing.
- Streamed events persist every entity they change, including existing entities inside a `create` payload and stored entities that are not in memory. An entity built from events is merged into its stored record (new optional `QueryStore.mergeEntity`), so the fields its events did not carry survive a restart.
- An entity that appears more than once in one response is applied and written once.
- A store write that throws is retried by the next apply. `AsyncQueryStore` reports finished writes back to the client, and both built-in stores resize their LRU queue when `cache.maxCount` changes.
- `QueryClient.destroy()` unsubscribes from the store, so a store no longer keeps every client created against it alive.
- A query whose cached value was rejected fetches even within `staleTime`. Snapshots work for entities created before a hot reload.
