/**
 * Decodes a Postgres `bytea` value as UTF-8 text.
 *
 * `pg` returns `bytea` columns as `Buffer`, while PGlite returns them as
 * `Uint8Array`. `String(value)` works for `Buffer` (it decodes as UTF-8) but
 * produces a comma-joined list of byte values for a plain `Uint8Array` (e.g.
 * `"123,34,..."`), so callers must decode explicitly rather than coerce with
 * `String()`. `TextDecoder` handles both input types uniformly.
 */
export function decodeBytea(value: Buffer | Uint8Array): string {
  return new TextDecoder().decode(value);
}
