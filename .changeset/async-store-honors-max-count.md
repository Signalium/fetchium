---
'fetchium': patch
---

`AsyncQueryStore`'s writer ignored a query definition's `cache.maxCount` and always used the default (50) when deciding when to evict the oldest key of a query definition. It now honors the def's own `maxCount`, matching `SyncQueryStore`.
