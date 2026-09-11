---
'fetchium': patch
---

Stop writing an entity to the store more than once per streamed event. `applyMutationEvent` ran `applyEntityRefs` with `persist: true`, which walks to the entity and writes it, then called `entityMap.save` on the same entity again unconditionally. `LiveArrayInstance.add` added a third write, re-saving a child whose record was already current. An update or create event wrote the entity twice, and an event that inserted into a live array wrote the child three times.

The apply already declines the write when the applied data is unchanged, so removing these saves takes a streamed event that changes nothing from one write to none. The remaining write is the one the apply performed, so an entity written by an event is still readable by a later client.
