---
'fetchium': patch
---

Fixes for the new client options and `useSuspenseQuery`.

- Custom `QueryClientConfig` keys still reach query code as `this.context`, including `shouldRetry`, `reactivationGraceMs` and `reactivationStaggerMs`, as every key did before those options existed. These names, `activity` and `pollResumeJitterMs` are reserved: a value under one of them is read as that option.
- `poll()` uses the context's `activity` only when it has `isActive` and `subscribe` functions. Any other value under that name (an app service passed through the config) is ignored, with a warning in development, instead of failing every polled query before its first fetch. `QueryContext` no longer declares `activity` or `pollResumeJitterMs`, so an app that augmented it with its own `activity` field compiles again.
- A non-finite `reactivationStaggerMs` or `pollResumeJitterMs` (such as `Infinity`) counts as 0 instead of scheduling a timer with an infinite delay. `reactivationGraceMs: Infinity` means "never refetch on reactivation". A `shouldRetry` that is not a function is ignored.
- `useSuspenseQuery`: a failed cold fetch whose retry render takes more than 50 ms to reach the reader (a large or time-sliced tree) reaches the error boundary instead of refetching in a loop. An error no render claims now waits 1 s, and after one more unclaimed failure the next waits 10 s. An error-boundary reset still retries. A tree abandoned while suspended and mounted again within a second of its fetch failing shows that error. Mounted later, it makes a new attempt.
- `Object.keys(this)` inside a query method no longer lists the internal `_notePush` hook.
