---
'fetchium': patch
---

Fixed memoized children (`component()` or `React.memo`) showing a stale value when given a nested value such as `token.price` as a prop. A nested `t.object`, `t.record` or live-collection value is now a new object when it changes, and keeps its identity when it doesn't.
