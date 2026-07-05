/**
 * Minimal shim around a Postgres-compatible driver's `query` method, used by
 * {@link AbstractPostgresJournalPersistenceAdapter} so the shared SQL can run
 * against either `pg`'s `Client` or PGlite's connection without depending on
 * either package directly.
 */
export interface JournalQueryRunner {
  query<T>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;
}
