---
'fetchium': patch
---

Add `EntityStore.clear()` and call it from `QueryClient.destroy()`. Previously `destroy()` cleared query instances, mutation instances, and every other internal registry, but left the entity map fully populated — a full teardown had no supported way to drop cached entities, forcing consumers to reach into `EntityStore`'s private `instances` map directly.
