---
'fetchium': patch
---

- Fixed `useSuspenseQuery` refetching in a loop when a retry render is slow.
- A query whose `getConfig()` throws now rejects with that error instead of breaking other queries.
- `shouldRetry`, `reactivationGraceMs`, `reactivationStaggerMs`, `activity` and `pollResumeJitterMs` are reserved `QueryClientConfig` names. Other keys still reach queries as `this.context`.
