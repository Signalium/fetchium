---
'fetchium': patch
---

Fixed child components showing stale nested values. A `component()` or `React.memo` child given a nested value as a prop (`token.price`: a `t.object` or `t.record` field, or a live collection's value) kept showing the old value after an update, because it received the same object. A changed nested value is now a new object, so the child re-renders. An unchanged one keeps its identity, so an update to another field doesn't re-render the child.
