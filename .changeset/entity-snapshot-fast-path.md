---
'fetchium': patch
---

Entity snapshots no longer walk the proxy to read fields, and an entity whose data hasn't changed is no longer re-read at all. Previously `Object.keys(proxy)` triggered a descriptor trap per key that computed the value in order to report it, so every field was read twice on every dependency change. Each entity now carries a version, and a snapshot taken at the same version re-reads only the fields whose values live elsewhere: child entities, live collections, and a query's own getters.

Array items are paired with the snapshot they produced themselves rather than the one at the same index, so inserting into or re-sorting a list no longer gives every existing row a new snapshot identity. Output is otherwise unchanged. Dev builds re-read the skipped fields to verify that, so the speedup is a production-build property.
