---
'fetchium': patch
---

`ExtractType` keeps `Date` as `Date`, so `t.format('date-time')` and `t.format('date')` fields are assignable to `Date`.
