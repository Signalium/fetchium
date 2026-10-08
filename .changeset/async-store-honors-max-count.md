---
'fetchium': patch
---

`AsyncQueryStore` now honors a query's `cache.maxCount`, as `SyncQueryStore` does. It used to always keep the default of 50 keys.
