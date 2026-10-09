---
"@telia-oss/xjog-journal-pg": patch
---

Live journal and full-state streams emitted only the newest entry when several landed between notifications; the rest were silently skipped.
