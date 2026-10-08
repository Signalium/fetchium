---
'fetchium': patch
---

- Fixed stale data when a query loads entities already in memory, and streamed updates lost on restart.
- Development builds freeze query results. Copy data before mutating it.
- Custom stores can implement the new optional `QueryStore.mergeEntity`.
