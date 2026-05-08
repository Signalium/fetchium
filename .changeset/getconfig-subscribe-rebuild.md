---
"fetchium": patch
---

`getConfig()` returning a different `subscribe` value mid-session now rebuilds the running subscriber. Previously, `setupSubscription` only consulted `config.subscribe` at activation, on params change, or when no subscriber was running, so patterns like `subscribe: poll({ interval: this.response?.ok ? 100 : 5000 })` and `subscribe: this.response?.status === 404 ? undefined : poll(...)` had no effect after the first activation.
