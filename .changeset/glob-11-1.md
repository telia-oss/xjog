---
"@telia-oss/xjog-core-pg": patch
"@telia-oss/xjog-core-pglite": patch
"@telia-oss/xjog-digest-pg": patch
"@telia-oss/xjog-digest-pglite": patch
"@telia-oss/xjog-journal-pg": patch
"@telia-oss/xjog-journal-pglite": patch
---

Resolve transitive `glob` (via node-pg-migrate) to >=11.1.0, fixing GHSA command injection in the glob CLI.
