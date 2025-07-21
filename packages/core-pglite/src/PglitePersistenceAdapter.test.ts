import { PglitePersistenceAdapter } from './PglitePersistenceAdapter';

describe('PglitePersistenceAdapter', () => {
  it('should be defined', () => {
    expect(PglitePersistenceAdapter).toBeDefined();
  });

  it('should be able to connect to a database', async () => {
    const adapter = await PglitePersistenceAdapter.connect();
    expect(adapter).toBeDefined();
  });
});
