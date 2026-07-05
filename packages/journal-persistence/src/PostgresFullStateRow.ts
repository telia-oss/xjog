/**
 * Full state entry row directly from the SQL query. `bytea` columns arrive as
 * `Buffer` from `pg` and `Uint8Array` from PGlite; both are decoded with
 * {@link decodeBytea} before being parsed as JSON.
 */
export type PostgresFullStateRow = {
  id: number;
  created: number;
  timestamp: number;

  ownerId: string;
  machineId: string;
  chartId: string;
  parentMachineId: string;
  parentChartId: string;

  event: Buffer | Uint8Array | null;
  state: Buffer | Uint8Array | null;
  context: Buffer | Uint8Array | null;
  actions: Buffer | Uint8Array | null;
};
