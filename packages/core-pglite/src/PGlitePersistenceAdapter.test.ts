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

describe('PGlitePersistenceAdapter: instance deregistration on graceful shutdown', () => {
  it('removeInstance excludes the instance from countAliveInstances', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();

    // overthrowOtherInstances marks all existing rows dying and inserts self
    // as the sole alive (dying=FALSE) instance — the clean-startup state.
    await adapter.overthrowOtherInstances('lone-instance', 'cid');
    expect(await adapter.countAliveInstances()).toBe(1);

    // Graceful shutdown calls removeInstance. Regression: this used to be a
    // no-op, so the departing instance still counted itself as alive
    // (countAliveInstances stayed 1), driving XJog.shutdown()'s adoption wait
    // into an infinite loop with no successor to adopt its charts.
    await adapter.removeInstance('lone-instance', 'cid');
    expect(await adapter.countAliveInstances()).toBe(0);
  });

  it('reaps long-dead instance rows on startup but keeps recent ones', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();

    await adapter.withTransaction(async (client) => {
      await client.exec('DELETE FROM "instances"');
      // Dying for longer than the retention window — should be reaped.
      await client.exec(
        `INSERT INTO "instances" ("instanceId", "dying", "timestamp")
         VALUES ('stale-dead', TRUE, now() - interval '2 hours')`,
      );
      // Recently marked dying — within retention, must be kept.
      await client.exec(
        `INSERT INTO "instances" ("instanceId", "dying", "timestamp")
         VALUES ('recent-dead', TRUE, now())`,
      );
    });

    // overthrowOtherInstances inserts the new instance and reaps stale rows.
    await adapter.overthrowOtherInstances('newbie', 'cid');

    const rows = await adapter.withTransaction(async (client) => {
      return client.query<{ instanceId: string }>(
        'SELECT "instanceId" FROM "instances" ORDER BY "instanceId"',
      );
    });
    const ids = rows.rows.map((r) => r.instanceId);

    expect(ids).toContain('newbie');
    expect(ids).toContain('recent-dead');
    expect(ids).not.toContain('stale-dead');
    // Only the freshly inserted instance is alive.
    expect(await adapter.countAliveInstances()).toBe(1);
  });

  it('does not reap a just-overthrown long-lived instance before it sees its death note', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();

    await adapter.withTransaction(async (client) => {
      await client.exec('DELETE FROM "instances"');
      // A live instance that has been running far longer than the retention
      // window, so its insert timestamp is older than the reap threshold.
      await client.exec(
        `INSERT INTO "instances" ("instanceId", "dying", "timestamp")
         VALUES ('long-lived', FALSE, now() - interval '2 hours')`,
      );
    });

    // A successor boots and overthrows. overthrowOtherInstances marks the old
    // instance dying and then reaps. Regression: marking dying must refresh the
    // timestamp, otherwise the old (2h) row is reaped in the same transaction —
    // and since onDeathNote treats a missing row as "not dying", the overthrown
    // instance would never trigger its own shutdown.
    await adapter.overthrowOtherInstances('successor', 'cid');

    const rows = await adapter.withTransaction(async (client) => {
      return client.query<{ instanceId: string; dying: boolean }>(
        'SELECT "instanceId", "dying" FROM "instances"',
      );
    });
    const longLived = rows.rows.find((r) => r.instanceId === 'long-lived');

    // Its row must survive (so its death-note poll can fire) and be marked dying.
    expect(longLived).toBeDefined();
    expect(longLived?.dying).toBe(true);
  });
});
