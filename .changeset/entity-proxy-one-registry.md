---
'fetchium': patch
---

Key each entity proxy into one `WeakMap` instead of three. The proxy's id now lives in its snapshot-source record, and the Signalium scope owner is registered on the first reactive method call.
