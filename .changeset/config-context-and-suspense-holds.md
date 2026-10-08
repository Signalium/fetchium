---
'fetchium': patch
---

`useSuspenseQuery` no longer refetches in a loop when a slow retry render takes a while to reach the component. The error goes to the error boundary, and resetting the boundary retries.

Custom `QueryClientConfig` keys still reach queries as `this.context`, except the reserved option names `shouldRetry`, `reactivationGraceMs`, `reactivationStaggerMs`, `activity` and `pollResumeJitterMs`. An invalid value for one of these options is ignored instead of breaking queries.
