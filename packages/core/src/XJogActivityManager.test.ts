import { PersistenceAdapter } from '@samihult/xjog-core-persistence';

import { XJogActivityManager } from './XJogActivityManager';
import { ActivityRef } from '@samihult/xjog-util';
import { XJog } from './XJog';
import { PGlitePersistenceAdapter } from '@samihult/xjog-core-pglite';

function mockXJogWithActivityManager(
  persistence: PersistenceAdapter,
  trace = false,
): [XJog, XJogActivityManager] {
  const xJog: any = {
    id: 'xjog-id',
    dying: false,
    persistence,
    trace: trace ? console.log : () => {},
    sendEvent: jest.fn(),
    emit: jest.fn(),
    options: {
      chartMutexTimeout: 100,
    },
  };

  xJog.activityManager = new XJogActivityManager(xJog);

  return [xJog as unknown as XJog, xJog.activityManager];
}

function mockActivity(): [ActivityRef, () => void] {
  const unsubscribe = jest.fn();

  const activity = {
    id: 'activity-id',
    owner: { machineId: 'machine-id', chartId: 'chart-id' },
    toJSON: jest.fn(() => ({ id: 'activity-id' })),
    send: jest.fn(),
    subscribe: jest.fn(() => ({ unsubscribe })),
    stop: jest.fn(),
  };

  return [activity as unknown as ActivityRef, unsubscribe];
}

describe('XJogActivityManager', () => {
  it('Can register and unregister activities', async () => {
    const persistence = await PGlitePersistenceAdapter.connect();
    const [, activityManager] = mockXJogWithActivityManager(persistence);

    const [activity] = mockActivity();

    await activityManager.registerActivity(activity);
    const resultsBefore = await persistence.withTransaction(async (client) => {
      return client.query('SELECT * FROM "ongoingActivities"');
    });

    expect(resultsBefore.rows[0]).toMatchObject({
      activityId: 'activity-id',
      chartId: 'chart-id',
      machineId: 'machine-id',
    });

    expect(activity.subscribe).toHaveBeenCalled();
    expect(activityManager.activityCount).toBe(1);
    // @ts-ignore Private access
    expect(activityManager.has(activity.owner!, activity.id)).toBe(true);

    await activityManager.stopAndUnregisteredActivity(activity);

    const resultsAfter = await persistence.withTransaction(async (client) => {
      return client.query('SELECT * FROM "ongoingActivities"');
    });
    expect(resultsAfter.rows).toHaveLength(0);

    expect(activity.stop).toHaveBeenCalled();
    expect(activityManager.activityCount).toBe(0);
    // @ts-ignore Private access
    expect(activityManager.ongoingActivities.has(activity.id)).toBe(false);
  });

  // Regression: `unregisterActivity` used to clean up `ongoingActivities` and
  // `autoForwards` but never the `ongoingActivitySubscriptions` map, and never
  // called `subscription.unsubscribe()`. Every activity ever registered left a
  // live subscription (whose closures retain the whole activity) behind for the
  // process lifetime — a slow heap leak proportional to checkout throughput.
  it('Unsubscribes and drops the subscription entry when an activity is stopped', async () => {
    const persistence = await PGlitePersistenceAdapter.connect();
    const [, activityManager] = mockXJogWithActivityManager(persistence);

    const [activity, unsubscribe] = mockActivity();

    await activityManager.registerActivity(activity);

    // @ts-ignore Private access
    const subscriptions = activityManager.ongoingActivitySubscriptions;
    expect(subscriptions.size).toBe(1);

    await activityManager.stopAndUnregisteredActivity(activity);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    // No leaked map entries: the machine map is collapsed once empty.
    expect(subscriptions.size).toBe(0);
  });

  it('Can relay events to activities', async () => {
    const persistence = await PGlitePersistenceAdapter.connect();
    const [, activityManager] = mockXJogWithActivityManager(persistence);

    const [activity] = mockActivity();

    await activityManager.registerActivity(activity);
    await activityManager.sendTo(activity.owner!, activity.id, 'test event');

    expect(activity.send).toHaveBeenCalledWith('test event');
  });

  // Regression: when an invoked promise's actor surfaces a rejection through
  // the activity-manager subscriber, the manager dispatches an
  // `error.platform.<id>` event via `xJog.sendEvent(...)`. That call returns
  // a promise. Before the fix the promise was fire-and-forget — if it
  // rejected (e.g. the parent chart had just been torn down or its onError
  // action threw during dispatch) the rejection escaped to
  // `process.unhandledRejection`. In production this killed the pod via the
  // process-level handler. The same shape applies to `next` (defer) and
  // `complete` (stopActivity).
  it('Does not leak unhandled rejections from sendEvent in the activity error subscriber', async () => {
    const persistence = await PGlitePersistenceAdapter.connect();
    const [xJog, activityManager] = mockXJogWithActivityManager(persistence);

    let captured: any = null;
    const activity = {
      id: 'activity-id',
      owner: { machineId: 'machine-id', chartId: 'chart-id' },
      toJSON: jest.fn(() => ({ id: 'activity-id' })),
      send: jest.fn(),
      subscribe: jest.fn((subscriber: any) => {
        captured = subscriber;
        return { unsubscribe: jest.fn() };
      }),
      stop: jest.fn(),
    } as unknown as ActivityRef;

    (xJog.sendEvent as jest.Mock).mockRejectedValue(
      new Error('Synthetic sendEvent failure'),
    );

    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', handler);

    try {
      await activityManager.registerActivity(activity);
      expect(captured).not.toBeNull();

      // Mimic what XJogChart.spawnPromise does on rejection: invoke the
      // subscriber's error callback. This synchronously fires-and-forgets
      // `xJog.sendEvent(...)`.
      captured.error(new Error('Activity rejected'));

      // Yield enough microtasks for the rejected sendEvent promise to be
      // observed as unhandled if no .catch was attached.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(xJog.sendEvent).toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', handler);
      await activityManager.stopAndUnregisteredActivity(activity);
    }
  });
});
