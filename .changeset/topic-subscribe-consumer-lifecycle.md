---
'fetchium': patch
---

Fix `TopicQuery` subscribe/unsubscribe to follow consumer-read lifecycle instead of the fetch path. Previously, `adapter.subscribe(topic)` was only invoked from `TopicQueryAdapter.send`, so it never fired when `send` short-circuited (pre-fulfilled topic via `fulfillTopic`, or in-memory cache within `staleTime`). The default `TopicQuery.getConfig.subscribe` only defined the cleanup half and depended on `_topicAdapter` being set inside `send`, so on those same paths the consumer's unmount would call `adapter.unsubscribe(topic)` without a matching subscribe, tearing down adapter state that was never registered. The adapter is now stashed on the execution context eagerly, the default `subscribe` implements both setup and cleanup, and the `subscribe` call is removed from `send`. Subscribe now fires on consumer activation and unsubscribe on deactivation, regardless of where the data came from.
