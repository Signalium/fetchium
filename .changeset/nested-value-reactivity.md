---
'fetchium': patch
---

Fixed memoized children not updating when passed a nested value such as `token.price`. Nested `t.object`, `t.record` and live-collection values are new objects when they change.
