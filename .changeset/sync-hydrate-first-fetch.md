---
'fetchium': patch
---

With `SyncQueryStore`, cached data shows on the first render, and the first fetch starts on a microtask. A cache entry that fails to load is refetched.
