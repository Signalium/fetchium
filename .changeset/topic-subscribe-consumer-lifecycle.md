---
'fetchium': patch
---

Fix `TopicQuery` subscribe/unsubscribe to track consumer-read lifecycle instead of the fetch path. Previously, subscribe never fired when `send()` short-circuited (pre-fulfilled topic via `fulfillTopic`, or cache within `staleTime`), but the consumer's unmount would still call unsubscribe and tear down adapter state that was never registered.
