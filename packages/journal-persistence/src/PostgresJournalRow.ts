/**
 * Journal entry row directly from the SQL query. `bytea` columns arrive as
 * `Buffer` from `pg` and `Uint8Array` from PGlite; both are decoded with
 * {@link decodeBytea} before being parsed as JSON.
 */
export type PostgresJournalRow = {
  id: number;
  timestamp: number;
  machineId: string;
  chartId: string;
  event: Buffer | Uint8Array | null;
  state: Buffer | Uint8Array | null;
  stateDelta: Buffer | Uint8Array;
  context: Buffer | Uint8Array | null;
  contextDelta: Buffer | Uint8Array;
  actions: Buffer | Uint8Array | null;
};
