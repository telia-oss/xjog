import { toSCXMLEvent } from 'xstate/lib/utils';

import { PGlitePersistenceAdapter } from '@samihult/xjog-core-pglite';
import { PersistenceAdapter } from '@samihult/xjog-core-persistence';
import { waitFor } from '@samihult/xjog-util';

import { XJogDeferredEventManager } from './XJogDeferredEventManager';
import { ResolvedXJogOptions } from './XJogOptions';
import { XJog } from './XJog';

function mockXJogWithDeferredEventManager(
  persistence: PersistenceAdapter,
  options: ResolvedXJogOptions['deferredEvents'],
  trace = false,
): [XJog, XJogDeferredEventManager] {
  const xJog: any = {
    id: 'xjog-id',
    dying: false,
    persistence,
    trace: trace ? console.log : () => {},
    timeExecution: jest.fn(),
    options: {
      deferredEvents: options,
    },
    sendEvent: jest.fn(),
  };

  xJog.deferredEventManager = new XJogDeferredEventManager(xJog);

  return [xJog as unknown as XJog, xJog.deferredEventManager];
}

describe('XJogDeferredEventManager', () => {
  it('Persists deferred events', async () => {
    const batchSize = 5;
    const lookAhead = 20;
    const interval = 10;

    // Withing the first read window
    const delay = 5;

    const persistence = await PGlitePersistenceAdapter.connect();
    const [xJog, deferredEventManager] = mockXJogWithDeferredEventManager(
      persistence,
      {
        batchSize,
        lookAhead,
        interval,
      },
    );

    try {
      const ref = { machineId: 'A', chartId: '1' };
      const event = toSCXMLEvent('event name');

      // Start scheduling like XJog.start would
      await deferredEventManager.scheduleUpcoming();

      await deferredEventManager.defer({ eventId: 'e', ref, event, delay });

      //expect(persistence.deferredEvents.rows.length).toBe(1);
      //const firstDeferredEventRow = persistence.deferredEvents.rows[0];
      //const deserializedEvent = JSON.parse(firstDeferredEventRow.event);

      /*       expect(firstDeferredEventRow).toMatchObject({
        id: 1,
        machineId: 'A',
        chartId: '1',
        delay,
        lock: null,
      });
      expect(firstDeferredEventRow.due - firstDeferredEventRow.timestamp).toBe(
        firstDeferredEventRow.delay,
      );
      expect(deserializedEvent).toMatchObject({
        $$type: 'scxml',
        name: 'event name',
        type: 'external',
      }); */
    } finally {
      await deferredEventManager.releaseAll();
    }
  });

  it('Schedules deferred events in the first batch', async () => {
    const batchSize = 5;
    const lookAhead = 30;
    const interval = 20;

    // Withing the first read window
    const delay = 10;

    const persistence = await PGlitePersistenceAdapter.connect();
    const [xJog, deferredEventManager] = mockXJogWithDeferredEventManager(
      persistence,
      {
        batchSize,
        lookAhead,
        interval,
      },
    );

    // This should be immediately scheduled at the startup,
    // because it is well withing the lookahead frame. The
    // first batch is read right in the startup sequence.

    try {
      const ref = { machineId: 'A', chartId: '1' };
      const event = toSCXMLEvent({ type: 'launch', product: 'windows 3.11' });

      await deferredEventManager.defer({ eventId: 'e', ref, event, delay });

      // Start scheduling like XJog.start would
      await deferredEventManager.scheduleUpcoming();

      // @ts-ignore Private access
      const scheduledEvent = deferredEventManager.deferredEvents[0];
      expect(scheduledEvent).toMatchObject({
        ref,
        delay,
        event,
        id: 1,
        eventId: 'e',
        to: null,
      });
      expect(scheduledEvent.due - scheduledEvent.timestamp).toBe(
        scheduledEvent.delay,
      );

      // @ts-ignore Private access
      expect(deferredEventManager.deferredEventTimers.size).toBe(1);

      //expect(persistence.deferredEvents.rows.length).toBe(1);
      //const firstDeferredEventRow = persistence.deferredEvents.rows[0];
      //expect(firstDeferredEventRow.lock).toBe(xJog.id);

      // Event should be sent after the delay
      await waitFor(delay);

      expect(xJog.sendEvent).toHaveBeenCalledWith(
        ref,
        event,
        undefined,
        expect.stringMatching(/.+/),
      );

      expect(deferredEventManager.deferredEventCount).toBe(0);
      // @ts-ignore Private access
      expect(deferredEventManager.deferredEventTimers.size).toBe(0);

      //expect(persistence.deferredEvents.rows.length).toBe(0);

      // @ts-ignore Private access
      xJog.dying = true;

      // After the interval, a new attempt to read scheduled events from the
      // database is carried out. This time it should exit the loop, since the
      // flag of death is flying.
      await waitFor(interval);

      // @ts-ignore Private access
      expect(deferredEventManager.deferredEventHandlerTimer).toBe(null);
    } finally {
      await deferredEventManager.releaseAll();
    }
  });

  it('Schedules deferred events in a subsequent batch', async () => {
    const batchSize = 5;
    const lookAhead = 20;
    const interval = 10;

    // Withing the second read window (then+lookahead)
    const delay = 25;

    const persistence = await PGlitePersistenceAdapter.connect();
    const [xJog, deferredEventManager] = mockXJogWithDeferredEventManager(
      persistence,
      {
        batchSize,
        lookAhead,
        interval,
      },
    );

    // This should be scheduled in the first read after the
    // startup because it is not withing the lookahead frame,
    // but fits the next frame.
    try {
      const ref = { machineId: 'A', chartId: '1' };
      const event = toSCXMLEvent({ type: 'launch', product: 'windows 3.11' });

      // Start scheduling like XJog.start would
      await deferredEventManager.scheduleUpcoming();

      await deferredEventManager.defer({ eventId: 'e', ref, event, delay });
      expect(deferredEventManager.deferredEventCount).toBe(0);

      // No events should come up in the first round
      expect(deferredEventManager.deferredEventCount).toBe(0);
      // @ts-ignore Private access
      expect(deferredEventManager.deferredEventTimers.size).toBe(0);

      // The next batch is read after the interval
      await waitFor(interval);

      // @ts-ignore Private access
      const scheduledEvent = deferredEventManager.deferredEvents[0];
      expect(scheduledEvent).toMatchObject({
        ref: {
          chartId: '1',
          machineId: 'A',
        },
        delay,
        event,
        eventId: 'e',
        to: null,
      });
      expect(scheduledEvent.due - scheduledEvent.timestamp).toBe(
        scheduledEvent.delay,
      );

      // @ts-ignore Private access
      expect(deferredEventManager.deferredEventTimers.size).toBe(1);

      // The event is sent after the remaining time
      await waitFor(delay - interval);

      expect(xJog.sendEvent).toHaveBeenCalledWith(
        ref,
        event,
        undefined,
        expect.stringMatching(/.+/),
      );

      // @ts-ignore Private access
      xJog.dying = true;

      // Wait for the instance to die naturally
      await waitFor(interval);
    } finally {
      await deferredEventManager.releaseAll();
    }
  });

  it('Cancels and removes the event when asked', async () => {
    const batchSize = 5;
    const lookAhead = 30;
    const interval = 20;

    // Withing the first read window
    const delay = 25;

    const persistence = await PGlitePersistenceAdapter.connect();
    const [xJog, deferredEventManager] = mockXJogWithDeferredEventManager(
      persistence,
      {
        batchSize,
        lookAhead,
        interval,
      },
    );

    // This should be immediately scheduled at the startup,
    // because it is well withing the lookahead frame. The
    // first batch is read right in the startup sequence.
    try {
      const ref = { machineId: 'A', chartId: '1' };
      const event = toSCXMLEvent({ type: 'launch', product: 'windows 3.11' });

      await deferredEventManager.defer({
        eventId: 'eventToBeCanceled',
        ref,
        event,
        delay,
      });

      // Start scheduling like XJog.start would
      await deferredEventManager.scheduleUpcoming();

      expect(deferredEventManager.deferredEventCount).toBe(1);
      // @ts-ignore Private access
      expect(deferredEventManager.deferredEventTimers.size).toBe(1);

      //expect(persistence.deferredEvents.rows.length).toBe(1);

      await deferredEventManager.cancel('eventToBeCanceled');

      expect(deferredEventManager.deferredEventCount).toBe(0);
      // @ts-ignore Private access
      expect(deferredEventManager.deferredEventTimers.size).toBe(0);

      //expect(persistence.deferredEvents.rows.length).toBe(0);

      // The event should not get sent
      await waitFor(delay);

      expect(xJog.sendEvent).not.toHaveBeenCalled();

      // @ts-ignore Private access
      xJog.dying = true;

      // Wait for the instance to die naturally
      await waitFor(interval);
    } finally {
      await deferredEventManager.releaseAll();
    }
  });

  it('Releases persisted deferred events during the shutdown', async () => {
    const batchSize = 5;
    const lookAhead = 30;
    const interval = 20;

    // Withing the first read window
    const delay = 25;

    const persistence = await PGlitePersistenceAdapter.connect();
    const [xJog, deferredEventManager] = mockXJogWithDeferredEventManager(
      persistence,
      {
        batchSize,
        lookAhead,
        interval,
      },
    );

    try {
      const ref = { machineId: 'A', chartId: '1' };
      const event = toSCXMLEvent({ type: 'launch', product: 'windows 3.11' });

      await deferredEventManager.defer({ eventId: 'e', ref, event, delay });

      //expect(persistence.deferredEvents.rows.length).toBe(1);
      //const firstDeferredEventRow = persistence.deferredEvents.rows[0];

      // Start scheduling like XJog.start would
      await deferredEventManager.scheduleUpcoming();

      // Event's been picked up and locked by this instance
      //expect(firstDeferredEventRow.lock).toBe(xJog.id);

      // @ts-ignore Private access
      xJog.dying = true;
      // Call releaseAll as XJog.shutdown would
      await deferredEventManager.releaseAll();

      expect(deferredEventManager.deferredEventCount).toBe(0);
      // @ts-ignore Private access
      expect(deferredEventManager.deferredEventTimers.size).toBe(0);

      //expect(persistence.deferredEvents.rows.length).toBe(1);
      //expect(firstDeferredEventRow.lock).toBe(null);

      // Wait for the instance to die naturally
      await waitFor(interval);

      // The event should never have been sent
      expect(xJog.sendEvent).not.toHaveBeenCalled();
    } finally {
      await deferredEventManager.releaseAll();
    }
  });
});
