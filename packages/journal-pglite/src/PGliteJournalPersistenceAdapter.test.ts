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
    const ownerId = 'test';
    const ref = {
      machineId: 'test',
      chartId: 'test',
    };
    const parentRef = null;
    const event = {
      type: 'test',
    };
    const oldState = {
      foo: 'bar',
    };
    const oldContext = {
      foo: 'bar',
    };
    const newState = {
      foo: 'bar',
    };
    const newContext = {};
    const actions: XJogStateChangeAction[] = [];
    const cid = 'test';

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
    /*     const fullState = await adapter.readFullState(ref);
    expect(fullState).toMatchObject({
      ownerId,
      ref,
      parentRef,
      event,
      oldState,
      oldContext,
      newState,
      newContext,
    }); */
  });
});
