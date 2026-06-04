---
'fetchium': patch
---

Fix the runtime merge so a discriminated union field is replaced when its variant changes. Previously the merge recursed into the union's typename-keyed shape, which matches no real field, so a changed variant left the old variant's fields in place and the new variant's fields never landed. Union fields are now replaced wholesale.
