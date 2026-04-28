---
"fetchium": patch
---

Resolve `TopicQuery` adapter via subclass-aware lookup. `TopicQuery` now assigns `static adapter = TopicQueryAdapter` so subclasses inherit a runtime value without per-class overrides, and `QueryClient.getAdapter()` falls back to an `instanceof` scan over registered adapters before auto-instantiating, so an abstract base on a query resolves to the consumer-registered concrete subclass. In dev builds, the lookup throws when more than one registered adapter would match the same lookup, surfacing ambiguous registrations early; the check is stripped in production builds.
