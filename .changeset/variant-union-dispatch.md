---
'fetchium': minor
---

Add `t.variant(value)`: a variant tag for union members that share a typename. `t.typename` keeps establishing entity identity (the `[typename, id]` cache key); `t.variant` selects which shape a payload parses as, so one entity type can have multiple shapes discriminated by a separate tag field. Parsing and live-collection event routing dispatch on the variant wherever members share a typename.

Two behavior changes:

- Unions now throw at definition time when two members share a typename without declaring variants, or collide on a `(typename, variant)` pair. Previously the last member silently overwrote the first, so payloads of the other shape failed validation and were dropped from arrays and mutation events.
- Live collections whose entity defs share a typename without variants (possible via `t.liveValue`, which involves no union) previously checked every event against the last def only; events now route to the first def the entity's data satisfies.
