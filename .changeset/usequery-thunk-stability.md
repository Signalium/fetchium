---
'fetchium': patch
---

Fix `useQuery` to stabilize thunk identity across re-renders. Without it, signalium allocated a new signal per render, which under some React commit orderings (React 18 / React Native) caused a spurious `getConfig.subscribe` cleanup while the consumer was still mounted.
