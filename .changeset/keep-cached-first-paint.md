---
'fetchium': patch
---

Cached data shows on the first render when two entity classes share a typename, such as a list class and a detail class with more fields. Previously the detail query waited for the network if the list had already loaded the entity.

- Writing an entity through one class keeps the other class's fields in the store, so the detail cache survives a restart. Records keep every class's fields, so loading the list from the cache also parses the detail's fields.
- Refetching the list no longer drops entities that only the detail references, such as a detail's nested `t.entity` field. The detail kept showing the old value but stopped getting updates for it, and its cache failed to load after a restart. This bug was in every earlier version.
- To wipe the cache, call the new `SyncQueryStore.clear()` instead of clearing the storage directly (such as MMKV `clearAll()`), which can bring deleted fields back.
- Custom stores can add the new optional `QueryStore` methods `readEntity`, `getEntityFieldNames`, `addEntityFieldNames` and `entityFieldNamesComplete`. Without them nothing changes.
