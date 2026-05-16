---
'fetchium': minor
---

`getConfig()` is now reactive: it re-runs whenever a signal consumed inside it notifies, instead of being recomputed on every fetch. `RESTQuery` exposes `this.responseNotifier` (a Signalium `Notifier`) on the execution context, fired by `RESTQueryAdapter` after each request completes. Wrap response reads in a `reactiveSignal` that calls `this.responseNotifier.consume()` to react to new responses, e.g. to drive a dynamic poll interval. Existing `getConfig()` implementations that never read reactive state continue to work unchanged.
