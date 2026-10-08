---
'fetchium': patch
---

Query results rebuild faster after an update: entities whose data didn't change are not read again.

List results also keep each row's object identity when the list is inserted into or re-sorted, so memoized rows don't re-render. Development builds still re-read everything to check the result, so the speedup shows in production builds only.
