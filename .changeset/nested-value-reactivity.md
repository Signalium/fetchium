---
'fetchium': patch
---

Nested values passed on their own stay reactive. A `t.object` or `t.record` field, and a live collection's value, keep their identity when an update changes them, because they are merged in place. A component (or reactive function) that received only the nested value, such as a `component()` child given `token.price` as a prop, read it without depending on anything, so it kept showing the old value whenever it was not re-rendered by its parent, which happens whenever its props are identical. Reads through a nested value now depend on that value: the in-place merge notifies it, and a live collection's value follows the collection. A change to another field of the entity does not re-run readers that hold only the nested value.
