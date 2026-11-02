---
'fetchium': minor
---

Add `QueryClient.setQueryData(QueryClass, params, data, { updatedAt })` for server rendering. It parses a raw API response with the query's own schema and gives the query's first read the data synchronously, whatever its `cacheTime` or store, so `renderToString` and the hydration render agree. With a fresh `updatedAt` and a `staleTime` that covers it, neither fetches, and `updatedAt` decides whether the first read refetches. `invalidateQueries` drops seeds that were not read yet, and `destroy()` drops them too. See the new Server Rendering guide.
