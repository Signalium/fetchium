---
'fetchium': patch
---

Keep the "skip the write when nothing changed" optimisation consistent with the store. The store deletes records on its own — an LRU eviction of the oldest key of a query definition, the refcount cascade that follows it, a stale purge — and the in-memory entity did not hear about it, so its next unchanged apply skipped the write while the query record was re-saved pointing at a value that no longer existed. On the next cold start that query's cache failed to hydrate ("the query cache may be corrupted or invalid") and was dropped. Any mounted query whose definition has more than `cache.maxCount` (default 50) live keys, refetching unchanged data, was affected.

`QueryStore` gains an optional `onDelete(listener)`; both built-in stores call it with every id they drop, and the client clears the entity's persisted flag so the next apply writes it again. A custom store that does not implement `onDelete` gets every persisted apply written, as before 0.6.0.

Also: an entity-array field narrowed by a shared-typename def (`t.array(t.entity(X))` with two entity classes for `X`) is re-narrowed after each apply, so a member that gains the fields the def requires shows up without the array itself having to change.
