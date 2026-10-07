---
'fetchium': major
---

Most apps need no changes. Tests that depend on loading frames, render counts or timers may.

- Query results are frozen in development. Copy data before mutating it.
- With `SyncQueryStore`, cached data shows on the first render.
- The first fetch and refetches without `debounce` start on a microtask, not after `setTimeout(0)`.
- Identical data no longer re-renders. Check `isFetching` instead of counting renders.
- Nested `t.object`, `t.record` and live-collection values are new objects when they change.
- `t.record` and `t.result` fields apply updates.
- Changing a Signal param mid-fetch aborts that fetch.
- After `QueryClient.destroy()`, queries reject with an `AbortError` and send no requests.
- If the last reader unmounts before a query's first data, `await fetchQuery(...)` waits for the next mount, collection or `destroy()`.
- `shouldRetry`, `reactivationGraceMs`, `reactivationStaggerMs`, `activity` and `pollResumeJitterMs` are reserved `QueryClientConfig` names.
- `retry: {}` and `retry: { retryDelay }` now retry like `retry: true`.
- `AsyncQueryStore` honors `cache.maxCount`.
