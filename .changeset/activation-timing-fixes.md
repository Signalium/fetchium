---
'fetchium': patch
---

Fixed errors and wrong data when a query mounts, unmounts or changes params quickly.

- Remounting a query no longer shows an `AbortError`. It shows its cached data, or stays pending, while it refetches.
- Changing a Signal param mid-fetch fetches the new params. Each params value of a non-entity result is cached separately.
- `QueryClient.destroy()` aborts fetches in flight. Queries read afterwards reject with an `AbortError` and send no requests.
