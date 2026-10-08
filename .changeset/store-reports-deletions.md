---
'fetchium': patch
---

Fixed cached queries failing to load after a restart ("the query cache may be corrupted or invalid") when a query had more than `cache.maxCount` cached params and refetched unchanged data.

- Custom stores: `QueryStore` has a new optional `onDelete(listener)`. Call the listener with every id the store deletes on its own. A store without it keeps writing every update, as before.
- A `t.array(t.entity(X))` field whose typename two entity classes share now shows an item as soon as it gains the fields `X` requires.
