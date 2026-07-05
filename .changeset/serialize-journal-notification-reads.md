---
'@telia-oss/xjog-journal-pg': patch
---

Serialize the two reads in the journal-entry notification handler. Both
`queryEntries` and `queryFullStates` route through `runReadQuery` on the single
shared read connection, and a `pg.Client` can only execute one query at a time.
Firing them in parallel triggered pg's "client is already executing a query"
deprecation warning (a hard throw in pg@9). They are now awaited sequentially.
