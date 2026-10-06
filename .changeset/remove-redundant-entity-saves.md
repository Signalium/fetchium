---
'fetchium': patch
---

Streamed updates write each changed entity to the store once instead of two or three times, and an update that changes nothing writes nothing.

A `create` event for an entity that no live collection shows is no longer written to the store, where it was never cleaned up.
