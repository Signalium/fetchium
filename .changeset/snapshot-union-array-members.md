---
'fetchium': patch
---

Snapshot fast path: a union whose only entity-bearing member is an array or record (`t.union(t.array(t.entity(A)), t.object({ ... }))`) was classified as a static field, so a snapshot taken at an unchanged version never re-read it and changes to those entities did not reach consumers (dev builds threw the stale-snapshot guard instead). Union members stored under the array/record symbol keys are now inspected like the others.
