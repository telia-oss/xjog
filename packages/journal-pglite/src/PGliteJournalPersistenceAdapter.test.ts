import { XJogStateChangeAction } from '@samihult/xjog-util';
import { PGliteJournalPersistenceAdapter } from './PGliteJournalPersistenceAdapter';

describe('PGliteJournalPersistenceAdapter', () => {
  it('should be defined', () => {
    expect(PGliteJournalPersistenceAdapter).toBeDefined();
  });

  it('should be able to connect to a database', async () => {
    const adapter = await PGliteJournalPersistenceAdapter.connect();
    expect(adapter).toBeDefined();
  });

  it('should read entry', async () => {
    const adapter = await PGliteJournalPersistenceAdapter.connect();
    const entry = await adapter.readEntry(1);
    expect(entry).toBeNull();
  });

  it('should read full state', async () => {
    const adapter = await PGliteJournalPersistenceAdapter.connect();
    const ownerId = 'ownerId';
    const ref = {
      machineId: 'machineId',
      chartId: 'chartId',
    };
    const parentRef = null;
    const event = {
      type: 'event',
    };
    const oldState = {
      state: 'old',
    };
    const oldContext = {
      ctx: 'old',
    };
    const newState = {
      state: 'new',
    };
    const newContext = {
      ctx: 'new',
    };
    const actions: XJogStateChangeAction[] = [];
    const cid = 'cid';

    await adapter.record(
      ownerId,
      ref,
      parentRef,
      event,
      oldState,
      oldContext,
      newState,
      newContext,
      actions,
      cid,
    );
    const fullState = await adapter.readFullState(ref);
    expect(fullState).toMatchObject({
      id: expect.any(Number),
      created: expect.any(Number),
      timestamp: expect.any(Number),
      ownerId,
      event: {
        type: 'event',
      },
      state: {
        state: 'new',
      },
      context: {
        ctx: 'new',
      },
      actions: [],
      ref: {
        machineId: 'machineId',
        chartId: 'chartId',
      },
    });
  });
});
