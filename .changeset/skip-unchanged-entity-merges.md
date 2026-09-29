---
'fetchium': minor
---

Applying data identical to what an entity already holds no longer notifies consumers. Previously an unchanged refetch or poll produced one notify per entity, plus a consumer recompute and a re-snapshot for each. Comparison is by value, and anything that can't be compared confidently — a `Date`, a typed array, a class instance — counts as changed, so the failure mode is a redundant notify rather than a dropped update. An unchanged entity is also no longer written to the store by the apply itself, though a streamed mutation event still writes it afterwards through a separate unconditional save in `applyMutationEvent`.

Two behavior changes: a refetch returning identical data no longer re-renders consumers, though `isPending`/`isFetching` still transition and the query's freshness record is still written; and record fields (`t.record(...)`) now apply updates at all, where merging previously recursed into the record's value type, iterated nothing, and restored the previous value.
