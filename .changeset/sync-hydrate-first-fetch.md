---
'fetchium': patch
---

With `SyncQueryStore`, a cached query renders its data on the first render instead of showing a loading frame first.

- The first fetch starts on a microtask instead of after `setTimeout(0)`. Tests that wait for a loading state or count renders may need updating.
- A cached entry that can't be loaded is treated as a cache miss and fetched. Previously a fresh-looking entry could leave the query pending without fetching.
