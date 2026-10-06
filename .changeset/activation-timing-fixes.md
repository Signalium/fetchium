---
'fetchium': patch
---

Fixes for the microtask first fetch and refetches introduced with synchronous hydration and fast delivery.

- A query mounted and unmounted in the same task (a guard that redirects in a layout effect, a `replace` on mount, a route re-keyed in one commit) no longer leaves its relay rejected with an `AbortError` that the next mount shows. Its first request, which now starts before Signalium's deactivation flush, is left to finish in the background, as it did when the first fetch started on a timer, and the next mount shows its data.
- A Signal param change made in the same task the query's last watcher leaves no longer sends a request that the deactivation then aborts. The refetch for a param change starts once Signalium's flush has run, which is in the same task when the change arrives through that flush.
- A query that reactivates stale in the same task the network goes offline waits for the network instead of rejecting with "Query is paused due to network status". The deferred refetch, a deferred restart and a debounced refetch recheck that the query is still active and not paused before they send.
- When a deactivation aborted the fetch in flight and the relay settled with the `AbortError`, the next activation refetches right away, as it already did for a relay still pending. A cached value is shown without the `AbortError` while it refetches. With no value yet, the relay is pending again but Signalium keeps reporting the previous error until the refetch lands. Callers awaiting the aborted fetch still get the `AbortError`.
