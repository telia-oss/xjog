---
"@telia-oss/xjog-core-persistence": minor
"@telia-oss/xjog-core-pg": minor
"@telia-oss/xjog-core-pglite": minor
---

Extract a shared generic `AbstractPostgresPersistenceAdapter` (positional `$N` SQL over an abstract `runQuery` normalizer); core-pg/core-pglite keep only their driver layer (connect, transactions, death-note polling).
