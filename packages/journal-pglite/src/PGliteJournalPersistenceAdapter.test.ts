import { PGliteJournalPersistenceAdapter } from './PGliteJournalPersistenceAdapter';

describe('PGliteJournalPersistenceAdapter', () => {
  it('should be defined', () => {
    expect(PGliteJournalPersistenceAdapter).toBeDefined();
  });

  it('should be able to connect to a database', async () => {
    const adapter = await PGliteJournalPersistenceAdapter.connect();
    expect(adapter).toBeDefined();
  });
});
