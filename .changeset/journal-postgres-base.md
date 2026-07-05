---
"@telia-oss/xjog-util": minor
"@telia-oss/xjog-journal-persistence": minor
"@telia-oss/xjog-journal-pg": minor
"@telia-oss/xjog-journal-pglite": minor
---

Extract a shared `AbstractPostgresJournalPersistenceAdapter` (positional `$N` SQL over role-based query hooks) and a shared `decodeBytea` helper in xjog-util; journal-pg/journal-pglite keep only their driver/connection layer.
