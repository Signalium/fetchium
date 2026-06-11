---
"fetchium": patch
---

Paused queries no longer schedule garbage collection, so resuming reuses the cached result instead of refetching. Previously a paused query with a low `gcTime` was evicted immediately and recreated on resume, dropping its polling interval. GC still runs on genuine teardown.
