---
'fetchium': patch
---

Faster streamed updates with `SyncQueryStore`. Merging an update into a stored entity that is not in memory reads and parses the stored record only for the first merge, not on every event (up to 1024 entities are remembered). This is the common case for full-payload updates on a typename that more than one entity class declares.
