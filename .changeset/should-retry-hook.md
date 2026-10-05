---
'fetchium': minor
---

Adds an optional `shouldRetry(error, attempt, status)` hook to `QueryClientConfig` and to `RetryConfig` (per query or mutation, overriding the client's). Return `false` to stop retrying an error you know is permanent, such as a 4xx from a given endpoint. `status` is the attempt's HTTP status when known: the response the adapter received (a REST error response whose body fails validation) or `status`, `statusCode` or `response.status` on the thrown error. Also exports `getErrorStatus`. Without a hook, retries are unchanged: every failed attempt is retried with the existing backoff. `RetryConfig.retries` is now optional and defaults as `retry: true` does.
