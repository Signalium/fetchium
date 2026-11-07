---
'fetchium': patch
---

A disabled `useQuery` whose Signal params moved to another cached key no longer loses an `invalidateQueries` call made while that cache read was pending. Enabling it again now refetches instead of treating the cache as fresh.
