/**
 * Digest record row directly from the SQL query, shared by every Postgres
 * compatible driver (`pg`, PGlite, …).
 */
export type PostgresDigestRow = {
  created: number;
  timestamp: number;
  machineId: string;
  chartId: string;
  key: string;
  value: string;
};
