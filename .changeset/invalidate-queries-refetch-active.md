---
"fetchium": patch
---

`queryClient.invalidateQueries(...)` now refetches any currently-mounted consumer of the matched queries, matching the React Query / SWR contract. Previously `markStale()` only reset `updatedAt`, so an active consumer kept showing stale data until it remounted; now `markStale()` also kicks a debounced refetch on the active relay (deduped against any in-flight fetch). Unmounted queries are still just marked stale: the next activation picks up the refetch via the existing stale-on-activate path.
