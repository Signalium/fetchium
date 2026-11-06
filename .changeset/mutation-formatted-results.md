---
'fetchium': patch
---

Fix mutation results to return the values produced by registered formats, including in nested fields. For example, date fields now return `Date` objects. You can also forward response objects from `getEffects()` to entity effects. Other effect payloads use raw values.

Array items that fail formatting are removed, including when a format uses `{ eager: false }`.
