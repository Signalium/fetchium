---
'fetchium': major
---

Upgrade notes: behavior an app can observe without using any new API. Each change has its own entry.

Rendering

- With `SyncQueryStore`, a cached query renders its data on the first render, with no loading frame. Tests that wait for a loading state or count renders may need updating.
- A refetch, poll or streamed update with identical data does not re-render. `isPending` and `isFetching` still change.
- `t.record` and `t.result` fields apply updates; a record field used to keep its old value.
- List snapshots keep each row's identity when the list is inserted into or re-sorted.
- A nested `t.object` or `t.record` value, or a live collection's value, is a new object after an update changes it, and keeps its identity otherwise.
- Development builds freeze query results, so mutating one throws a `TypeError`. Treat production results as read-only too.

Fetching

- The first fetch, and a refetch without `debounce`, start on a microtask instead of after `setTimeout(0)`.
- On resume, a subscription is restored before the request is sent, so a socket that replays a cached value no longer overwrites the fresh response.
- Changing a Signal param mid-fetch aborts that fetch and fetches the new params. A late response for the old params is dropped.
- A query unmounted mid-fetch refetches as soon as it mounts again, without showing the `AbortError`.
- `retry: {}` and `retry: { retryDelay }` retry like `retry: true`. A `shouldRetry` hook can stop retrying permanent errors.
- `shouldRetry`, `reactivationGraceMs`, `reactivationStaggerMs`, `activity` and `pollResumeJitterMs` are reserved `QueryClientConfig` names. Other keys still reach queries as `this.context`.
- `QueryClient.destroy()` aborts every fetch in flight (whoever awaits one gets an `AbortError`), and nothing is written to the store after it.

Cache and store

- A cached entry that can't be applied is treated as a miss and fetched, even within `staleTime`.
- A query whose result is not an entity caches each params key separately. Caches from earlier versions are corrected as each key is fetched again.
- Streamed events persist the entities they change.
- `QueryStore` gains optional `mergeEntity`, `onDelete`, `onPersisted`, `isSettled`, `hasQueuedDeletes` and `hasEntity`. A custom store without them writes as before. A store write that throws is retried.
- `AsyncQueryStore` honors `cache.maxCount`, and both built-in stores resize their LRU queue when it changes.
