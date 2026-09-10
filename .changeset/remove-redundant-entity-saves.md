---
'fetchium': patch
---

Stop writing an entity to the store more than once per streamed event. `applyMutationEvent` ran `applyEntityRefs` with `persist: true`, which walks to the entity and writes it, and then called `entityMap.save` on the same entity again unconditionally. `LiveArrayInstance.add` added a third write, re-saving a child the apply pass had already written. An update or create event wrote the entity twice, and an event that inserted into a live array wrote the child three times.

Nothing else changes: the remaining write is the one the apply already performed, so an entity written by an event is still readable after a restart.
