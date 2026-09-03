---
'@telia-oss/xjog-util': patch
---

Accept `TEXT` columns in `decodeBytea`. Databases provisioned before the chart
and journal payload columns were declared `BYTEA` still hold them as `TEXT`, and
their initial migration is already recorded as applied, so nothing converts
them. `pg` returns those rows as strings, which `TextDecoder` rejects with
`ERR_INVALID_ARG_TYPE` — every chart read against such a database threw, where
the previous `row.state.toString()` call sites had tolerated both shapes.
Strings now pass through unchanged; `Buffer` and `Uint8Array` still decode as
UTF-8. `null` keeps throwing.
