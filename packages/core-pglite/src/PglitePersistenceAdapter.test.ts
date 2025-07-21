import { PglitePersistenceAdapter } from './PglitePersistenceAdapter';

describe('PglitePersistenceAdapter', () => {
  it('should be defined', () => {
    expect(PglitePersistenceAdapter).toBeDefined();
  });

  it('should be able to connect to a database', async () => {
    const adapter = await PglitePersistenceAdapter.connect();
    expect(adapter).toBeDefined();
  });

  it('should run migrations', async () => {
    const adapter = await PglitePersistenceAdapter.connect({
      dataDir: 'test.db',
    });
    expect(adapter).toBeDefined();

    const result = await adapter.withTransaction(async (client) => {
      return client.exec('SELECT 1');
    });
    expect(result).toBeDefined();
  });
});
