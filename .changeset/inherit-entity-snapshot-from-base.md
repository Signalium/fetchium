---
'fetchium': patch
---

Fix entity reactivity across the React boundary. The entity proxy's `get` trap was short-circuiting all symbol-keyed property access to `undefined`, which blocked Signalium's `registerCustomSnapshot` from finding its handler (stored under a private symbol on the prototype). Symbol gets now resolve via `Reflect.get` against the entity prototype. With that in place, the per-class `ensureEntitySnapshotRegistered` bookkeeping is no longer needed — Signalium's prototype-chain resolution makes a single registration on the `Entity` base class apply to all user-defined entity subclasses.
