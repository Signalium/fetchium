---
"fetchium": patch
---

`TopicQuery` subclasses now inherit their adapter from the base, and `QueryClient.getAdapter()` resolves an abstract adapter class on a query to a consumer-registered concrete subclass. Generated and hand-authored `TopicQuery` classes no longer need a per-class `static adapter` override. In dev, ambiguous registrations (more than one adapter that matches the same lookup) throw with a clear error.
