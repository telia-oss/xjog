import { PGlitePersistenceAdapter } from './PGlitePersistenceAdapter';

describe('PGlitePersistenceAdapter', () => {
  it('should be defined', () => {
    expect(PGlitePersistenceAdapter).toBeDefined();
  });

  it('should be able to connect to a database', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();
    expect(adapter).toBeDefined();
  });

  it('should run migrations', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();
    expect(adapter).toBeDefined();
  });

  it('should run a transaction', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();
    const result = await adapter.withTransaction(async (client) => {
      return client.exec('DELETE FROM "deferredEvents"');
    });
    expect(result[0].affectedRows).toBe(0);
  });

  it('should be able to defer an event', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();
    const eventCount = 10;
    await adapter.withTransaction(async (client) => {
      return client.exec('DELETE FROM "deferredEvents"');
    });

    for (let i = 0; i < eventCount; i++) {
      const result = await adapter.deferEvent({
        ref: {
          machineId: 'machineId',
          chartId: 'chartId',
        },
        event: {
          type: 'internal',
          name: 'test',
          data: {},
          $$type: 'scxml',
        },
        eventTo: 'machineId',
        delay: 1000,
        lock: 'lock',
      });
      expect(result).toMatchObject({
        eventId: expect.any(String),
        eventTo: 'machineId',
        delay: 1000,
        due: expect.any(String),
        lock: null,
        event: {},
        ref: {
          machineId: 'machineId',
          chartId: 'chartId',
        },
      });
    }

    const batchSize = 2;
    const events = await adapter.takeUpcomingDeferredEvents(
      'machineId',
      1000,
      batchSize,
    );
    expect(events.length).toBe(batchSize);
    expect(events).toMatchObject([
      {
        eventId: expect.any(String),
        eventTo: 'machineId',
        delay: 1000,
        due: expect.any(String),
        lock: 'machineId',
        event: {},
      },
      {
        eventId: expect.any(String),
        eventTo: 'machineId',
        delay: 1000,
        due: expect.any(String),
        lock: 'machineId',
        event: {},
      },
    ]);
  });

  it('should be able to remove an event', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();
    const event = await adapter.removeDeferredEvent({
      id: 1,
      eventId: '1',
      eventTo: 'machineId',
      event: {
        type: 'internal',
        name: 'test',
        data: {},
        $$type: 'scxml',
      },
      timestamp: 1000,
      delay: 1000,
      due: 1000,
      lock: 'machineId',
      ref: { machineId: 'machineId', chartId: 'chartId' },
    });
    expect(event).toBeUndefined();
  });

  it('should release deferred events', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();
    const event = await adapter.releaseDeferredEvent(
      { machineId: 'machineId', chartId: 'chartId' },
      1,
    );
    expect(event).toBeUndefined();
  });
});
