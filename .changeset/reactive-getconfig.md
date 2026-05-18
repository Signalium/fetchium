---
'fetchium': minor
---

**Breaking:** `getConfig()` is now memoized via a `reactiveSignal` instead of being recomputed on every fetch; it only re-runs when a signal consumed inside notifies. Existing implementations that read mutable execution-context state directly (most commonly `this.response`) silently return stale config after first evaluation, because plain field reads track no signals. To react to new responses, wrap the read in a `reactiveSignal` thunk that consumes the newly-exposed `this.responseNotifier` (a Signalium `Notifier` on the execution context, fired by `RESTQueryAdapter` after each request): `reactiveSignal(() => { this.responseNotifier.consume(); return this.response?.ok; }).value`. `getConfig()` implementations that don't read mutable ctx state continue to work unchanged.
