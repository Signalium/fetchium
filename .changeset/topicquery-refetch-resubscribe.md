---
"fetchium": patch
---

Fix `TopicQuery` refetch and `invalidateQueries` returning stale data on still-mounted consumers. Adds an optional `QueryAdapter.invalidate(ctx)` lifecycle method (`TopicQueryAdapter` implements it as `unsubscribe(topic)`; stateless adapters like REST don't need it). `QueryInstance` now calls `adapter.invalidate?.(ctx)` before each `send()` on the refetch path, and `markStale()` kicks a debounced refetch when the relay is currently active so `invalidateQueries` actually refreshes mounted consumers without requiring a deactivate/reactivate cycle.
