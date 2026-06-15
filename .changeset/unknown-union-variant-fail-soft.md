---
"fetchium": patch
---

Handle unknown union variants instead of silently dropping the whole entity update. An optional union field now degrades to `undefined`; a non-optional one surfaces an `UnknownUnionVariantError` (visible, not a swallowed warn) and applies no partial state. Initial load and live updates behave the same.
