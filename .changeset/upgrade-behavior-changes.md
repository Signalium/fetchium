---
'fetchium': major
---

Breaking changes. Most apps need no code changes, but tests that depend on loading frames, render counts or timers may.

- **Results are frozen in development.** Mutating query data throws a `TypeError`; copy it first (`[...data.items].sort()`).
- **Cached data shows on the first render** with `SyncQueryStore`. Update tests that wait for a loading state or count renders.
- **Fetches start sooner.** The first fetch and refetches without `debounce` start on a microtask, not after `setTimeout(0)`; update tests that advance timers to see them.
- **Identical data doesn't re-render.** A refetch, poll or streamed update with the same data skips the render; read `isFetching` instead of counting renders.
- **Nested values change identity only when they change.** `t.object`, `t.record` and live-collection values are new objects after a change, so memoized children re-render; drop workarounds that forced it.
- **`t.record` and `t.result` fields apply updates** instead of keeping their old value.
- **Changing a Signal param mid-fetch aborts that fetch** and fetches the new params; the old response is dropped.
- **`QueryClient.destroy()` aborts fetches in flight.** Code that awaits a query during teardown gets an `AbortError`; catch it.
- **Awaiting a query can wait for a remount.** If the last component using a query unmounts before its first data arrives, `await fetchQuery(...)` waits for the next mount, `gcTime` collection or `destroy()` instead of rejecting with an `AbortError`.
- **New reserved `QueryClientConfig` names:** `shouldRetry`, `reactivationGraceMs`, `reactivationStaggerMs`, `activity` and `pollResumeJitterMs` are read as options; rename custom context values that use them.
- **`retry: {}` and `retry: { retryDelay }` now retry** like `retry: true`; use `retry: false` for no retries.
- **`AsyncQueryStore` honors `cache.maxCount`.** Check the value if you set one.
- **Custom `QueryStore`s** get new optional methods (`mergeEntity`, `onDelete`, `onPersisted`, `isSettled`, `hasQueuedDeletes`, `hasEntity`); without them nothing changes.
