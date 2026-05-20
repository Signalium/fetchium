---
'fetchium': patch
---

Add `getTopic()` to `TopicQuery` for parity with `getPath()` on `RESTQuery`. The static `topic` template only supports fixed-shape topics, so consumers with variable-segment-count or conditionally-shaped topics had to hand-author one query class per shape. Subclasses can now override `getTopic()` to compute the topic dynamically at execution time over the resolved params (e.g. `'layout:' + this.params.segments.map(encodeURIComponent).join(':')`); when defined it takes precedence over the `topic` field. The `topic` field is now optional, matching `path?` on `RESTQuery`. Existing queries that define `topic` as a static template continue to work unchanged.
