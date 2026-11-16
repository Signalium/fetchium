---
'fetchium': minor
---

Add `useQueries` to `fetchium/react` for a list of queries whose length or contents change between renders: `useQueries(ids.map(id => ({ query: GetUser, params: { id } })))`. Each entry takes the same `query`, `params` and `enabled` as `useQuery`, and the hook returns one `useQuery`-shaped result per entry, in order. A fixed list of different queries returns a typed tuple. Adding, removing or reordering entries doesn't refetch the ones that stay, and an entry whose data didn't change keeps its result identity.
