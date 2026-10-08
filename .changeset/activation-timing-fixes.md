---
'fetchium': patch
---

Fixed errors and wrong data when a query mounts, unmounts or changes params quickly.

- Remounting a query after an aborted fetch shows its cached data, or stays pending, instead of an `AbortError`. A topic query with no data that mounts and unmounts in the same task is the exception: it shows the `AbortError` until its data arrives, and its first awaiter rejects.
- Changing a Signal param mid-fetch fetches the new params. Each params value of a non-entity result is cached separately.
- `QueryClient.destroy()` aborts fetches in flight. Queries read afterwards reject with an `AbortError` and send no requests.
