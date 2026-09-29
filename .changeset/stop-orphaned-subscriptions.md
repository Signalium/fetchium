---
'fetchium': patch
---

Stop query subscriptions (such as `poll()`) from leaking after a query deactivates. If a query deactivated while a fetch was in flight, the aborted fetch restarted the subscription on the inactive query, and nothing ever stopped it, even after the query was evicted. Pollers built up with each navigation and kept refetching. Subscriptions now start only while the query is active, and eviction also stops any subscription still running.
