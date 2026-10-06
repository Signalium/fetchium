---
'fetchium': patch
---

Fixed spurious errors and wrong data when a query mounts, unmounts or changes params quickly.

- Unmounting and remounting a query, in the same task or mid-fetch (switching a chart timeframe and back), no longer shows an `AbortError`. The query shows its cached data, or stays pending, while it refetches. One exception: a topic query with no data that mounts and unmounts in the same task shows the `AbortError` on its next mount until its data arrives (before, it stayed pending forever).
- Changing a Signal param mid-fetch fetches the new params instead of showing the old params' response. A query whose result is not an entity now caches each params value separately; a cold start could show another params value's data.
- `QueryClient.destroy()` aborts every fetch in flight, and code awaiting one gets an `AbortError`.
