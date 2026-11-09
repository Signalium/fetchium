---
'fetchium': patch
---

Key each entity proxy into two `WeakMap`s instead of three. The proxy's id now lives in its snapshot-source record.
