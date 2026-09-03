/**
 * Decodes a Postgres `bytea` value as UTF-8 text.
 *
 * `pg` returns `bytea` columns as `Buffer`, while PGlite returns them as
 * `Uint8Array`. `String(value)` works for `Buffer` (it decodes as UTF-8) but
 * produces a comma-joined list of byte values for a plain `Uint8Array` (e.g.
 * `"123,34,..."`), so callers must decode explicitly rather than coerce with
 * `String()`. `TextDecoder` handles both input types uniformly.
 *
 * A `string` passes through unchanged. Databases provisioned before these
 * columns were declared `BYTEA` still hold them as `TEXT`, and the initial
 * migration is recorded as applied there, so no later migration converts them.
 * `pg` hands such rows back as strings, and `TextDecoder` rejects a string
 * outright with `ERR_INVALID_ARG_TYPE` — which broke every chart read against
 * those databases. The previous `row.state.toString()` call sites tolerated
 * both shapes; this keeps that behaviour while still decoding `Uint8Array`
 * correctly.
 */
export function decodeBytea(value: Buffer | Uint8Array | string): string {
  return typeof value === 'string' ? value : new TextDecoder().decode(value);
}
