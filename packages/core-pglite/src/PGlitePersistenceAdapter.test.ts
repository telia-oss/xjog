import { PGlitePersistenceAdapter } from './PGlitePersistenceAdapter';

describe('PglitePersistenceAdapter', () => {
  it('should be defined', () => {
    expect(PGlitePersistenceAdapter).toBeDefined();
  });

  it('should be able to connect to a database', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();
    expect(adapter).toBeDefined();
  });

  it('should run migrations', async () => {
    const adapter = await PGlitePersistenceAdapter.connect({
      dataDir: 'test.db',
    });
    expect(adapter).toBeDefined();

    const result = await adapter.withTransaction(async (client) => {
      return client.exec('SELECT 1');
    });
    expect(result).toBeDefined();
  });
});
