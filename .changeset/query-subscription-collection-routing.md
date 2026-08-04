---
"fetchium": patch
---

Route membership events from a query's own `config.subscribe` into unconstrained live collections in its result. Query subscriptions stamped the query key as the event source, but live collections register under their parent entity's key, so `create`/`update` for an unseen id never inserted and `delete` never removed. Field updates on rows already present were unaffected, which made the gap silent. Entity `__subscribe` routing and constrained collections are unchanged.
