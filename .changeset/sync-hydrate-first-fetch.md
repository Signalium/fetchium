---
'fetchium': patch
---

A query whose cached value lives in a synchronous store (`SyncQueryStore`) now resolves with that value in the same read that activates it, instead of a microtask later. A component that mounts such a query renders the cached data on its first render, not a loading state followed by a re-render. The first fetch, and the subscription before it, now start on a microtask instead of after a `setTimeout(0)`, which on device waits a frame or more. Neither runs inside the activating read. `AsyncQueryStore` hydrates on the tick its load resolves, as before.

A cached entry that fails to apply is now treated as a cache miss, so the query fetches. Previously it kept the entry's timestamp, and a fresh-looking timestamp could leave the query pending without fetching.
