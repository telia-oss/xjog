import { PGliteDigestPersistenceAdapter } from './PGliteDigestPersistenceAdapter';

describe('PGliteDigestPersistenceAdapter', () => {
  it('should be defined', () => {
    expect(PGliteDigestPersistenceAdapter).toBeDefined();
  });

  it('should be able to connect to a database', async () => {
    const adapter = await PGliteDigestPersistenceAdapter.connect();
    expect(adapter).toBeDefined();
  });
});
