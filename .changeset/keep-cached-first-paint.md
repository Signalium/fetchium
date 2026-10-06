---
'fetchium': patch
---

Cached data now shows on the first render when two entity classes share a typename, such as a list class and a detail class with more fields. Before, the detail query waited for the network if the list had already loaded the entity.

- Writing an entity through one class keeps the other class's fields in the store, so the detail cache survives a restart. Loading the list from the cache now also parses those fields.
- Refetching the list no longer drops entities that only the detail references, such as its nested `t.entity` field. Before, the detail kept the old value, stopped getting updates for it, and its cache failed to load after a restart. This bug was in every earlier version.
- To wipe the cache, call the new `SyncQueryStore.clear()`, not the storage's own clear (such as MMKV `clearAll()`), which can bring deleted fields back.
- Custom stores can add the new optional `QueryStore` methods `readEntity`, `getEntityFieldNames`, `addEntityFieldNames` and `entityFieldNamesComplete`. Without them nothing changes.
