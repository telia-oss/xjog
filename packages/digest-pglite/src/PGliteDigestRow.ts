/**
 * Digest record row directly from the SQL query
 */
export type PGliteDigestRow = {
  created: number;
  timestamp: number;
  machineId: string;
  chartId: string;
  key: string;
  value: string;
};
