---
'fetchium': patch
---

Batch parent saves during live array resets. `addChildRef`/`removeChildRef` each called `save()`, and `LiveArrayInstance.reset()` called them once per item — serializing and persisting the full parent once per child reference update instead of once overall. The entity-apply flow now writes the completed parent a single time, preserving add-before-remove retention.
