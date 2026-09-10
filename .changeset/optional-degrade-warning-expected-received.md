---
'fetchium': patch
---

Include `expected` and `received` type names in the warning logged when an optional field's value fails to match its type. Previously only the value and path were reported, while the required-field branch already named both through `typeError`.
