/**
 * Minimal shim around a Postgres-compatible driver's `query` method, used by
 * {@link AbstractPostgresDigestPersistenceAdapter} so the shared SQL can run
 * against either `pg`'s `Pool` or PGlite's connection without depending on
 * either package directly.
 */
export interface PostgresQueryRunner {
  query<T>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;
}
