---
'fetchium': patch
---

Fix mutation results to return the values produced by registered formats, including in nested fields. For example, date fields now return `Date` objects. The same values are available in `getEffects()` and can update cached entities.

Array items that fail formatting are removed, including when a format uses `{ eager: false }`.
