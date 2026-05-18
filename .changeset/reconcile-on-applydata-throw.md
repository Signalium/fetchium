---
'fetchium': patch
---

Fix reactive `getConfig()` not reacting to error responses when the response body fails to parse against the result schema. Previously `runQuery` only called `reconcileSubscription` after `applyData` succeeded, so a 404 (or any other status) whose body did not match the entity shape would throw inside `parseEntities`, skip the reconcile, and leave the running subscriber installed against stale config. The reconcile call is now in a `finally` block so it fires after every fetch attempt, regardless of whether parsing succeeds.
