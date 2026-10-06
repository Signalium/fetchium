---
'fetchium': patch
---

Fixes for the new client options and `useSuspenseQuery`.

- Custom `QueryClientConfig` keys still reach queries as `this.context`. `shouldRetry`, `reactivationGraceMs`, `reactivationStaggerMs`, `activity` and `pollResumeJitterMs` are reserved: a value under one of them is read as that option.
- `poll()` ignores an `activity` value without `isActive` and `subscribe` functions (with a warning in development) instead of failing every polled query. `QueryContext` no longer declares `activity` or `pollResumeJitterMs`.
- `Infinity` for `reactivationStaggerMs` or `pollResumeJitterMs` counts as 0, and `reactivationGraceMs: Infinity` never refetches on reactivation. A `shouldRetry` that is not a function is ignored.
- `useSuspenseQuery` no longer refetches in a loop when a slow retry render takes too long to reach the component; the error goes to the error boundary, and resetting the boundary retries.
- `Object.keys(this)` inside a query no longer lists an internal hook.
