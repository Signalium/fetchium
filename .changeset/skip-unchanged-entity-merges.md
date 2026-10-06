---
'fetchium': minor
---

A refetch, poll or streamed update that returns the same data no longer re-renders your components. `isPending` and `isFetching` still change as before.

- Values that can't be compared reliably (a `Date`, a typed array, a class instance) always count as changed.
- `t.record(...)` fields now apply updates. Previously a record field kept its old value.
