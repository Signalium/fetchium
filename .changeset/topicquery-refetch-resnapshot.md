---
"fetchium": patch
---

Fix `TopicQuery` refetch returning stale data. `TopicQueryAdapter.send()` now tears down the previous subscription and re-subscribes when called against an already fulfilled or rejected topic, so explicit `__refetch()` and stale-on-reactivate paths receive a fresh snapshot from the underlying stream instead of the cached payload.
