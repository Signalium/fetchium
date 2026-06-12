---
"fetchium": minor
---

Paused queries no longer schedule garbage collection, so resuming reuses the cached result instead of refetching. Previously a paused query with a low `gcTime` was evicted immediately and recreated on resume, dropping its polling interval. GC still runs on genuine teardown.

This relies on the `isPausing` flag signalium passes to `RelayHooks.deactivate` (see https://github.com/Signalium/signalium/pull/242), so the `signalium` peer requirement is now `>=3.0.3` (was `>=3.0.1`).
