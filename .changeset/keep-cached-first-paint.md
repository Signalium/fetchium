---
'fetchium': patch
---

Fixed cached data not showing on first render when two entity classes share a typename, such as a list class and a detail class.

- Writes through one class keep the other class's fields, so the cache survives a restart. With `AsyncQueryStore`, only for classes registered in the session.
- New `SyncQueryStore.clear()`. Use it to wipe the cache instead of the storage's own clear.
- Custom stores can implement the new optional `readEntity`, `getEntityFieldNames`, `addEntityFieldNames` and `entityFieldNamesComplete`.
