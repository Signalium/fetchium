---
'fetchium': patch
---

- Fixed cached queries failing to load after a restart when a query had more than `cache.maxCount` cached entries.
- Custom stores can implement the new optional `QueryStore.onDelete(listener)`.
