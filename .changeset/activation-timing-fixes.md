---
'fetchium': patch
---

Timing fixes for mounting, unmounting and changing params.

- A query mounted and unmounted in the same task (a redirect in a layout effect, a `replace` on mount) no longer shows an `AbortError` on its next mount: its first request finishes in the background. Releasing a `prefetch()` or `retain()` lease still aborts the fetch it started.
- A query unmounted mid-fetch and mounted again (a chart switched to another timeframe and back) no longer flashes an error. With no data yet it stays pending and refetches; with cached data it shows that data while it refetches.
- Changing a Signal param while a fetch is in flight aborts it and fetches the new params, instead of showing and caching the old params' response under the new key. A param set in the same task the query mounts is fetched right away, and a param change makes a remounted query refetch even if its old data was fresh.
- A query whose result is not an entity caches each params key separately. Previously every key's cache pointed at the latest params' data, so a cold start could show another key's data. This bug was in every earlier version.
- A stale query that mounts as the network goes offline waits for the network instead of rejecting with "Query is paused due to network status".
- A topic query mounted and unmounted in the same task no longer stays pending forever on its next mount. `TopicQueryAdapter.send()` honors its abort signal, including under React Native's `AbortController` polyfill.
- `QueryClient.destroy()` aborts and cancels every fetch; whoever awaits one gets an `AbortError`, and nothing is written to the store afterwards.
- With `gcTime: 0`, a query is collected only once its first fetch settles, so its entities no longer leak.
- Also: `reactivationStaggerMs` spreads the refetches that resume after a pause, a `__fetchNext()` page for stale params is dropped, and with an asynchronous store a param change during the cache load no longer applies the old params' entry.
