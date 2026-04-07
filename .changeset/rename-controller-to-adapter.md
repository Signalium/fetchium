---
"fetchium": minor
---

Rename *Controller to *Adapter across the entire API surface. `QueryController`, `RESTQueryController`, and `TopicQueryController` are now `QueryAdapter`, `RESTQueryAdapter`, and `TopicQueryAdapter`. The `static controller` property on Query/Mutation classes is now `static adapter`, and the `controllers` option on `QueryClient` is now `adapters`.
