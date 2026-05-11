---
'fetchium': minor
---

Upgrade to Signalium v3 and React 19.

### Peer dependency bumps

- `signalium` peer is now `>=3.0.0` (was `>=2.1.7`).
- `react` peer is now `>=19.0.0` (was `>=18.3.1`). Required by Signalium v3 for `React.cache` and React 19's thenable handling in `<Suspense>`.

### API changes

- `QueryPromise<T>` now resolves to `ReactivePromise<QueryResult<T>>`. In Signalium v3 `ReactivePromise<T>` is itself the discriminated union (the v2 `DiscriminatedReactivePromise<T>` alias has been removed upstream), so `if (p.isReady)` narrows `p.value` to `T` directly without the previous extra type gymnastics. No call-site changes are required for code that already used `QueryPromise<T>`.
- `useQuery` is now a thin wrapper around v3's deep-by-default `useReactive`. The previous hand-rolled `cloneDeep` proxy implementation has been removed — Signalium v3 provides structurally-shared snapshots natively, so `React.memo` on subtree props now correctly skips re-renders when the underlying data is unchanged.

### Internal

- Registers a custom Signalium snapshot for entity proxies (`registerCustomSnapshot`), so `useReactive` / `useQuery` correctly walk into entities at the React boundary and re-render on field changes.
- All `useReactive(fn, ...args)` call sites in tests updated to the v3 thunk form `useReactive(() => fn(...args))`.
- `SuspendSignalsProvider` references replaced with `PauseSignalsProvider` (renamed upstream in v3).
