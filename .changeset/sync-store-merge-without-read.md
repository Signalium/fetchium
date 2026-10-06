---
'fetchium': patch
---

`SyncQueryStore.mergeEntity` no longer reads and parses the stored record on every merge. A streamed full payload for an entity that is not in memory, on a typename more than one class declares, is a partial write (the payload lacks the other classes' fields), so each such event merged over the record on disk: a `getString` and a `JSON.parse` per event. The store now keeps, per entity it merged into, what the record holds besides the merged fields, and the next merge of the same fields appends that to the payload's JSON without reading. Only the first merge per entity reads. Any other write or deletion of the record through a store over the same kv drops what was kept, so a merge never restores a value another write replaced. At most 1024 entities are kept; past that the least recently merged reads again.
