---
'@telia-oss/xjog-digest-pg': patch
---

Release the connection-check client in `PostgresDigestPersistenceAdapter.connect()`; the unreleased client permanently occupied a pool slot and made `disconnect()` hang forever waiting for `pool.end()`.
