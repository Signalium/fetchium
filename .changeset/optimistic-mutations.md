---
'fetchium': minor
---

Implement `optimisticUpdates` on mutations. The flag was previously stored but ignored. Static `effects` entries that read only `params` now apply before the request and roll back if it fails; overlapping `run()` calls are allowed for these mutations, and each rolls back only its own changes.

`RESTMutation` now rejects a non-2xx response with `RESTResponseError` (exported from `fetchium/rest`, with `status` and the unread `response`), instead of resolving with the error body when the app's `fetch` doesn't throw. Mutations whose `fetch` already threw are unaffected.
