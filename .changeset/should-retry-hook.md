---
'fetchium': minor
---

New `shouldRetry(error, attempt, status)` option on `QueryClientConfig` and `retry` configs. Return `false` to stop retrying, for example on a 404. `getErrorStatus` is exported and `retry.retries` is now optional.
