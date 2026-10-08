---
'fetchium': minor
---

New optional `shouldRetry(error, attempt, status)` on `QueryClientConfig` and on a query's or mutation's `retry` config. Return `false` to stop retrying an error you know is permanent, such as a 404.

`status` is the HTTP status when it is known, and `getErrorStatus` is exported. Without the hook, retries work as before. `retry.retries` is now optional.
