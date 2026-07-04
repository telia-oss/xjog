import type { XJogStateChangeAction } from '@telia-oss/xjog-util';
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

  // Regression: a broken record() override wrote no journal entries at all,
  // hardcoded the full-state id to 1 (making the second record() call throw
  // against its own stale-write guard), and never emitted notifications
  it('should append journal entries and advance full state on repeated record calls', async () => {
    const adapter = await PGliteJournalPersistenceAdapter.connect();
    const ownerId = 'ownerId';
    const ref = {
      machineId: 'repeatMachine',
      chartId: 'repeatChart',
    };
    const actions: XJogStateChangeAction[] = [];

    await adapter.record(
      ownerId,
      ref,
      null,
      { type: 'first' },
      null,
      null,
      { state: 'one' },
      { ctx: 1 },
      actions,
      'cid-1',
    );

    await adapter.record(
      ownerId,
      ref,
      null,
      { type: 'second' },
      { state: 'one' },
      { ctx: 1 },
      { state: 'two' },
      { ctx: 2 },
      actions,
      'cid-2',
    );

    const entries = await adapter.queryEntries({ ref });
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBeLessThan(entries[1].id);
    expect(entries[0].event).toEqual({ type: 'first' });
    expect(entries[1].event).toEqual({ type: 'second' });

    const firstEntry = await adapter.readEntry(entries[0].id);
    expect(firstEntry).not.toBeNull();

    const fullState = await adapter.readFullState(ref);
    expect(fullState).toMatchObject({
      id: entries[1].id,
      state: { state: 'two' },
      context: { ctx: 2 },
    });
  });

  it('should query entries by chart reference array', async () => {
    const adapter = await PGliteJournalPersistenceAdapter.connect();
    const refA = { machineId: 'arrayMachine', chartId: 'chart-a' };
    const refB = { machineId: 'arrayMachine', chartId: 'chart-b' };
    const actions: XJogStateChangeAction[] = [];

    for (const [ref, state] of [
      [refA, 'a'],
      [refB, 'b'],
    ] as const) {
      await adapter.record(
        'ownerId',
        ref,
        null,
        { type: 'event' },
        null,
        null,
        { state },
        null,
        actions,
      );
    }

    const entries = await adapter.queryEntries([refA, refB]);
    expect(entries).toHaveLength(2);

    const onlyA = await adapter.queryEntries([refA]);
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].ref).toEqual(refA);
  });
});
