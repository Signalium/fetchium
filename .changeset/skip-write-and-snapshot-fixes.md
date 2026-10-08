---
'fetchium': patch
---

Fixed stale data in components when a second query loads entities that are already in memory, and streamed updates that were lost on restart.

- Development builds freeze query results, so mutating one (such as calling `sort()` on a list in render) throws a `TypeError`. Copy the data first, and treat production results as read-only too.
- In development, the stale-data check logs an error instead of throwing and blocking other components' updates.
- Custom stores can add the new optional `QueryStore.mergeEntity`, so an entity built from streamed updates doesn't overwrite stored fields those updates didn't include. Without it, writes work as before.
