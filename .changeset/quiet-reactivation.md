---
'fetchium': minor
---

New `QueryClient` options, all off by default:

- `reactivationGraceMs` (also per query): skip the refetch when a query remounts with data younger than this.
- `reactivationStaggerMs`: spread the refetches of queries that remount together across this window.
- `activity` and `pollResumeJitterMs`: pause `poll()` while the app is inactive and spread overdue polls on resume.
- `TopicQueryAdapter.sendMutationEvent(event, topic)` counts the event as fresh data for that topic's query.
