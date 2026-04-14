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

  it('should return a near-immediate due time for zero-delay events', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();

    await adapter.withTransaction(async (client) => {
      return client.exec('DELETE FROM "deferredEvents"');
    });

    const before = Date.now();
    const event = await adapter.deferEvent({
      ref: {
        machineId: 'machineId',
        chartId: 'chartId',
      },
      event: {
        type: 'internal',
        name: 'test-zero-delay',
        data: {},
        $$type: 'scxml',
      },
      eventTo: null,
      delay: 0,
      lock: null,
    });
    const after = Date.now();

    expect(event.delay).toBe(0);
    expect(Number(event.due)).toBeGreaterThanOrEqual(before - 50);
    expect(Number(event.due)).toBeLessThanOrEqual(after + 50);
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

describe('PGlitePersistenceAdapter: orphan-locked deferred events released on startup', () => {
  it('Releases all deferred event locks during overthrowOtherInstances', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();

    // Seed a deferred event with a lock set to simulate a dead instance that
    // was killed without graceful shutdown (releaseAll never ran).
    await adapter.withTransaction(async (client) => {
      await client.exec('DELETE FROM "deferredEvents"');
      await client.exec(
        `INSERT INTO "deferredEvents"
          ("eventId", "machineId", "chartId", "event", "delay", "due", "lock")
         VALUES ('evt-orphan', 'm', 'c', '{}', 0, NOW(), 'dead-instance-uuid')`,
      );
    });

    // Verify the lock is set before we call overthrowOtherInstances
    const before = await adapter.withTransaction(async (client) => {
      return client.query('SELECT "lock" FROM "deferredEvents"');
    });
    expect(before.rows[0].lock).toBe('dead-instance-uuid');

    // overthrowOtherInstances should now clear the lock as part of startup
    await adapter.overthrowOtherInstances('new-instance-uuid', 'cid');

    // Lock must be NULL so the new instance can pick up the event
    const after = await adapter.withTransaction(async (client) => {
      return client.query('SELECT "lock" FROM "deferredEvents"');
    });
    expect(after.rows[0].lock).toBeNull();
  });
});
