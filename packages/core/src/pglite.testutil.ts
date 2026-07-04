import { PGlitePersistenceAdapter } from '@samihult/xjog-core-pglite';

/**
 * Test-only helper for PGlite-backed persistence.
 *
 * Each `PGlitePersistenceAdapter.connect()` opens a pool that keeps handles
 * alive; if a test never disconnects, the Jest worker can't exit gracefully
 * ("A worker process has failed to exit gracefully..."). Connect through this
 * helper instead — every adapter is tracked and disconnected in an `afterEach`
 * that registers automatically when a test file imports this module.
 */
const openAdapters: PGlitePersistenceAdapter[] = [];

export async function connectTestPersistence(): Promise<PGlitePersistenceAdapter> {
  const adapter = await PGlitePersistenceAdapter.connect();
  openAdapters.push(adapter);
  return adapter;
}

afterEach(async () => {
  await Promise.all(
    openAdapters.splice(0).map((adapter) => adapter.disconnect()),
  );
});
