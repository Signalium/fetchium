---
'fetchium': minor
---

Queries no longer retry client errors. A failed attempt whose HTTP status is 4xx (other than 408 and 429) now fails at once instead of being retried three times; network errors and 5xx responses still retry. The status comes from the response the adapter received (a REST error response whose body fails validation) or from `status`, `statusCode` or `response.status` on the thrown error.

Adds `shouldRetry(error, attempt, status)` to `QueryClientConfig` and to `RetryConfig` (per query or mutation, overriding the client's) to decide retries yourself, and exports the default as `defaultShouldRetry` along with `getErrorStatus`. `RetryConfig.retries` is now optional and defaults as `retry: true` does.
