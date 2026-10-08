---
'fetchium': minor
---

New `QueryClient` options that make coming back to a screen, or to the app, quieter. All are off by default.

- `reactivationGraceMs` (also per query): a query that mounts again with data younger than this doesn't refetch. Data a live subscription kept current counts as fresh.
- `reactivationStaggerMs`: refetches from queries that mount together are spread across this window instead of all starting at once.
- `activity: { isActive(), subscribe(listener) }`: `poll()` stops while the app is inactive and resumes when it's active again. On React Native, wrap `AppState`. `pollResumeJitterMs` spreads out polls that were overdue on resume.
- Pass the topic to `TopicQueryAdapter.sendMutationEvent(event, topic)` so that topic's query counts the push as fresh data.
