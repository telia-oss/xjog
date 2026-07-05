---
"@telia-oss/xjog-util": minor
"@telia-oss/xjog": patch
---

util: collapse the 15 payload-less `XJogStateChange*Action` stub types into a
single `XJogStateChangePlainAction` (`{ type: XJogStateChangePlainActionType }`).
The serialized shape of journaled actions is unchanged; only type names were
removed. Code that imported one of the removed aliases (e.g.
`XJogStateChangeLogAction`) should switch to `XJogStateChangePlainAction`.

util: `XJogActionTypes` is now a real enum instead of `declare enum`, so
`XJogActionTypes.Unknown` exists at runtime (previously it was `undefined` and
comparing against it could never match — or crashed on member access).

core: `mapActions` uses `XJogActionTypes.Unknown` instead of a hardcoded
`'xjog.unknown'` literal (same runtime value) and drops its blanket
`@ts-expect-error`; the mapping is now fully type-checked.
