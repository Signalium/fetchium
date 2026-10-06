---
'fetchium': patch
---

Cached data shows on the first render when two entity classes share a typename, such as a list class and a detail class with more fields.

- A detail query's cached data is used even when the list class already holds the entity in memory; the fields the list class doesn't declare come from the cache. Previously the cache was dropped and the screen waited for the network.
- Writing an entity through one class no longer deletes the other class's fields from the store, so the detail screen's cache survives a restart.
- `SyncQueryStore` remembers each typename's field names across launches, and forgets a name no class has declared for 30 days. For 30 days after this version first opens a store that already holds data, records may still hold fields of a class not registered since, so they keep being merged rather than overwritten.
- New `SyncQueryStore.clear()`. Use it to wipe the cache instead of clearing the underlying storage directly (an MMKV `clearAll()`): clients are not told about records deleted underneath them, and a later write can put deleted fields back.
- `QueryStore` gains optional `readEntity`, `getEntityFieldNames`, `addEntityFieldNames` and `entityFieldNamesComplete`, and `saveEntity` takes an optional fourth argument. A custom store without them behaves as before. `AsyncQueryStore` only knows the classes registered in the current session.
- Cost: a record holds the fields of every class of its typename, so hydrating the list class parses the detail fields too (a cached 100-entity list hydrates about a third slower in our benchmark). Typenames with one class are unaffected.
