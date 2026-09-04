---
'fetchium': patch
---

Reuse a single `ParseContext` across `applyMutationEvent()` calls instead of allocating a fresh one (plus two `Map`s) per event. This path runs once for every entity update received over a live subscription (e.g. SSE), often many times per frame on high-frequency streams.
