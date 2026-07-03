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

describe('PGlitePersistenceAdapter: live handoff primitives', () => {
  async function seed(
    adapter: PGlitePersistenceAdapter,
    args: {
      instances?: Array<{ id: string; dying?: boolean; ageSeconds?: number }>;
      charts?: Array<{
        machineId?: string;
        chartId: string;
        ownerId: string | null;
        paused?: boolean;
      }>;
      activities?: Array<{ machineId?: string; chartId: string; activityId: string }>;
      deferredLocks?: Array<{ chartId: string; lock: string | null }>;
    },
  ): Promise<void> {
    await adapter.withTransaction(async (client) => {
      await client.exec('DELETE FROM "deferredEvents"');
      await client.exec('DELETE FROM "ongoingActivities"');
      await client.exec('DELETE FROM "charts"');
      await client.exec('DELETE FROM "instances"');

      for (const instance of args.instances ?? []) {
        await client.query(
          `INSERT INTO "instances" ("instanceId", "dying", "timestamp")
           VALUES ($1, $2, now() - make_interval(secs => $3))`,
          [instance.id, instance.dying ?? false, instance.ageSeconds ?? 0],
        );
      }

      for (const chart of args.charts ?? []) {
        await client.query(
          `INSERT INTO "charts"
             ("machineId", "chartId", "ownerId", "paused", "state")
           VALUES ($1, $2, $3, $4, decode('7b7d', 'hex'))`,
          [
            chart.machineId ?? 'machine',
            chart.chartId,
            chart.ownerId,
            chart.paused ?? false,
          ],
        );
      }

      for (const activity of args.activities ?? []) {
        await client.query(
          `INSERT INTO "ongoingActivities" ("machineId", "chartId", "activityId")
           VALUES ($1, $2, $3)`,
          [activity.machineId ?? 'machine', activity.chartId, activity.activityId],
        );
      }

      for (const deferred of args.deferredLocks ?? []) {
        await client.query(
          `INSERT INTO "deferredEvents"
             ("machineId", "chartId", "eventId", "event", "delay", "due", "lock")
           VALUES ('machine', $1, '"1"', '{}', 1000, now() + interval '1 hour', $2)`,
          [deferred.chartId, deferred.lock],
        );
      }
    });
  }

  async function chartRows(
    adapter: PGlitePersistenceAdapter,
  ): Promise<Array<{ chartId: string; ownerId: string | null; paused: boolean }>> {
    const result = await adapter.withTransaction(async (client) =>
      client.query<{ chartId: string; ownerId: string | null; paused: boolean }>(
        'SELECT "chartId", "ownerId", "paused" FROM "charts" ORDER BY "chartId"',
      ),
    );
    return result.rows;
  }

  it('registerInstance adds an alive row without disturbing live siblings', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();
    await seed(adapter, {
      instances: [
        { id: 'sibling', ageSeconds: 10 },
        { id: 'long-dead', dying: true, ageSeconds: 2 * 60 * 60 },
      ],
      charts: [{ chartId: 'c1', ownerId: 'sibling' }],
    });

    await adapter.registerInstance('newbie', 'cid');

    const instances = await adapter.withTransaction(async (client) =>
      client.query<{ instanceId: string; dying: boolean }>(
        'SELECT "instanceId", "dying" FROM "instances" ORDER BY "instanceId"',
      ),
    );

    // Sibling untouched, self registered alive, long-dead row reaped.
    expect(instances.rows).toEqual([
      { instanceId: 'newbie', dying: false },
      { instanceId: 'sibling', dying: false },
    ]);

    // Sibling's chart neither paused nor stolen.
    expect(await chartRows(adapter)).toEqual([
      { chartId: 'c1', ownerId: 'sibling', paused: false },
    ]);
  });

  it('heartbeatInstance refreshes only the own, alive row', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();
    await seed(adapter, {
      instances: [
        { id: 'me', ageSeconds: 120 },
        { id: 'other', ageSeconds: 120 },
      ],
    });

    await adapter.heartbeatInstance('me');

    const rows = await adapter.withTransaction(async (client) =>
      client.query<{ instanceId: string; ageSeconds: number }>(
        `SELECT "instanceId",
                extract(epoch from now() - "timestamp") AS "ageSeconds"
         FROM "instances" ORDER BY "instanceId"`,
      ),
    );

    const me = rows.rows.find((row) => row.instanceId === 'me');
    const other = rows.rows.find((row) => row.instanceId === 'other');
    expect(Number(me?.ageSeconds)).toBeLessThan(5);
    expect(Number(other?.ageSeconds)).toBeGreaterThan(100);
  });

  it('markStaleInstancesDying marks stale siblings but spares self, fresh and dying rows', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();
    await seed(adapter, {
      instances: [
        { id: 'me', ageSeconds: 120 },
        { id: 'stale-sibling', ageSeconds: 120 },
        { id: 'fresh-sibling', ageSeconds: 1 },
        { id: 'already-dying', dying: true, ageSeconds: 120 },
      ],
    });

    await adapter.markStaleInstancesDying('me', 60_000);

    const rows = await adapter.withTransaction(async (client) =>
      client.query<{ instanceId: string; dying: boolean }>(
        'SELECT "instanceId", "dying" FROM "instances" ORDER BY "instanceId"',
      ),
    );

    expect(rows.rows).toEqual([
      { instanceId: 'already-dying', dying: true },
      { instanceId: 'fresh-sibling', dying: false },
      { instanceId: 'me', dying: false },
      { instanceId: 'stale-sibling', dying: true },
    ]);
  });

  it('pauseOrphanedCharts pauses charts not owned by a live instance', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();
    await seed(adapter, {
      instances: [
        { id: 'live' },
        { id: 'dying', dying: true },
      ],
      charts: [
        { chartId: 'live-owned', ownerId: 'live' },
        { chartId: 'dying-owned', ownerId: 'dying' },
        { chartId: 'reaped-owned', ownerId: 'gone' },
        { chartId: 'unowned', ownerId: null },
        { chartId: 'already-paused', ownerId: 'gone', paused: true },
      ],
    });

    const pausedCount = await adapter.pauseOrphanedCharts('cid');

    expect(pausedCount).toBe(3);
    expect(await chartRows(adapter)).toEqual([
      { chartId: 'already-paused', ownerId: 'gone', paused: true },
      { chartId: 'dying-owned', ownerId: 'dying', paused: true },
      { chartId: 'live-owned', ownerId: 'live', paused: false },
      { chartId: 'reaped-owned', ownerId: 'gone', paused: true },
      { chartId: 'unowned', ownerId: null, paused: true },
    ]);
  });

  it('releaseOrphanedDeferredEvents unlocks events held by non-live instances', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();
    await seed(adapter, {
      instances: [
        { id: 'live' },
        { id: 'dying', dying: true },
      ],
      deferredLocks: [
        { chartId: 'a', lock: 'live' },
        { chartId: 'b', lock: 'dying' },
        { chartId: 'c', lock: 'gone' },
        { chartId: 'd', lock: null },
      ],
    });

    await adapter.releaseOrphanedDeferredEvents('cid');

    const rows = await adapter.withTransaction(async (client) =>
      client.query<{ chartId: string; lock: string | null }>(
        'SELECT "chartId", "lock" FROM "deferredEvents" ORDER BY "chartId"',
      ),
    );

    expect(rows.rows).toEqual([
      { chartId: 'a', lock: 'live' },
      { chartId: 'b', lock: null },
      { chartId: 'c', lock: null },
      { chartId: 'd', lock: null },
    ]);
  });

  it('gentle adoption claims are atomic: a chart is adopted by exactly one instance', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();
    await seed(adapter, {
      instances: [{ id: 'a' }, { id: 'b' }],
      charts: [
        { chartId: 'idle-paused', ownerId: 'gone', paused: true },
        { chartId: 'busy-paused', ownerId: 'gone', paused: true },
        { chartId: 'running', ownerId: 'a' },
      ],
      activities: [{ chartId: 'busy-paused', activityId: 'act-1' }],
    });

    const adoptedByA = await adapter.gentlyAdoptCharts('a', 'cid');
    const adoptedByB = await adapter.gentlyAdoptCharts('b', 'cid');

    // Only the idle paused chart is gently adoptable, and only once.
    expect(adoptedByA.map((ref) => ref.chartId)).toEqual(['idle-paused']);
    expect(adoptedByB).toEqual([]);

    expect(await chartRows(adapter)).toEqual([
      { chartId: 'busy-paused', ownerId: 'gone', paused: true },
      { chartId: 'idle-paused', ownerId: 'a', paused: false },
      { chartId: 'running', ownerId: 'a', paused: false },
    ]);
  });

  it('forced adoption claims paused charts and clears their ongoing activities', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();
    await seed(adapter, {
      instances: [{ id: 'b' }],
      charts: [
        { chartId: 'busy-paused', ownerId: 'gone', paused: true },
        { chartId: 'running', ownerId: 'b' },
      ],
      activities: [
        { chartId: 'busy-paused', activityId: 'act-1' },
        { chartId: 'running', activityId: 'act-2' },
      ],
    });

    const adopted = await adapter.forciblyAdoptCharts('b', 'cid');

    expect(adopted.map((ref) => ref.chartId)).toEqual(['busy-paused']);
    expect(await chartRows(adapter)).toEqual([
      { chartId: 'busy-paused', ownerId: 'b', paused: false },
      { chartId: 'running', ownerId: 'b', paused: false },
    ]);

    const activities = await adapter.withTransaction(async (client) =>
      client.query<{ chartId: string }>(
        'SELECT "chartId" FROM "ongoingActivities" ORDER BY "chartId"',
      ),
    );
    // The adopted chart's stale activity rows are gone; the running chart's stay.
    expect(activities.rows).toEqual([{ chartId: 'running' }]);
  });

  it('pauseOwnCharts pauses exactly the charts owned by the instance', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();
    await seed(adapter, {
      instances: [{ id: 'me' }, { id: 'other' }],
      charts: [
        { chartId: 'mine', ownerId: 'me' },
        { chartId: 'theirs', ownerId: 'other' },
      ],
    });

    await adapter.pauseOwnCharts('me', 'cid');

    expect(await chartRows(adapter)).toEqual([
      { chartId: 'mine', ownerId: 'me', paused: true },
      { chartId: 'theirs', ownerId: 'other', paused: false },
    ]);
  });
});

describe('PGlitePersistenceAdapter: onDeathNote', () => {
  async function waitUntil(
    predicate: () => boolean,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it('calls the callback when the instance is marked dying', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();

    await adapter.withTransaction(async (client) => {
      await client.exec('DELETE FROM "instances"');
      await client.exec(
        `INSERT INTO "instances" ("instanceId", "dying") VALUES ('doomed', FALSE)`,
      );
    });

    const callback = jest.fn();
    const cancel = adapter.onDeathNote('doomed', callback);

    try {
      // Not dying yet: the poller must stay quiet.
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(callback).not.toHaveBeenCalled();

      await adapter.withTransaction(async (client) => {
        await client.exec(
          `UPDATE "instances" SET "dying" = TRUE WHERE "instanceId" = 'doomed'`,
        );
      });

      await waitUntil(() => callback.mock.calls.length > 0, 3000);
      expect(callback).toHaveBeenCalledTimes(1);
    } finally {
      cancel();
    }
  });

  it('does not call the callback after cancellation', async () => {
    const adapter = await PGlitePersistenceAdapter.connect();

    await adapter.withTransaction(async (client) => {
      await client.exec('DELETE FROM "instances"');
      await client.exec(
        `INSERT INTO "instances" ("instanceId", "dying") VALUES ('spared', FALSE)`,
      );
    });

    const callback = jest.fn();
    const cancel = adapter.onDeathNote('spared', callback);
    cancel();

    await adapter.withTransaction(async (client) => {
      await client.exec(
        `UPDATE "instances" SET "dying" = TRUE WHERE "instanceId" = 'spared'`,
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(callback).not.toHaveBeenCalled();
  });
});
