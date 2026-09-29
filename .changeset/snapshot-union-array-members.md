---
'fetchium': patch
---

Fixed components not updating when an entity changes inside a union that has an array or record member, such as `t.union(t.array(t.entity(A)), t.object({ ... }))`.
