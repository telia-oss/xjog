import { decodeBytea } from './decodeBytea';

describe('decodeBytea', () => {
  const json = '{"value":"älytön"}';

  it('decodes a Buffer as UTF-8', () => {
    expect(decodeBytea(Buffer.from(json))).toBe(json);
  });

  it('decodes a Uint8Array as UTF-8', () => {
    expect(decodeBytea(new TextEncoder().encode(json))).toBe(json);
  });

  // Regression: TextDecoder rejects a string with ERR_INVALID_ARG_TYPE, so
  // reads from a database whose columns are still TEXT rather than BYTEA
  // threw instead of returning the stored JSON
  it('passes a string through unchanged', () => {
    expect(decodeBytea(json)).toBe(json);
  });

  it('decodes an empty value to an empty string', () => {
    expect(decodeBytea(Buffer.alloc(0))).toBe('');
    expect(decodeBytea('')).toBe('');
  });
});
