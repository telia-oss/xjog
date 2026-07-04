import {
  ChartOwnershipLostError,
  type PersistenceAdapter,
} from '@samihult/xjog-core-persistence';

import { PGlitePersistenceAdapter } from '@samihult/xjog-core-pglite';
import { waitFor } from '@samihult/xjog-util';
import { toSCXMLEvent } from 'xstate/lib/utils';
import type { XJog } from './XJog';
import { XJogDeferredEventManager } from './XJogDeferredEventManager';
import type { ResolvedXJogOptions } from './XJogOptions';

function createInMemoryPersistence(
  delayTakeUpcomingByMs = 0,
): PersistenceAdapter {
  let nextId = 1;
  const deferredEvents: any[] = [];

  return {
    deferEvent: jest.fn(async (event) => {
      deferredEvents.push({
        ...event,
        id: nextId++,
        timestamp: Date.now(),
        due: Date.now() + event.delay,
      });
    }),
    takeUpcomingDeferredEvents: jest.fn(async () => {
      if (delayTakeUpcomingByMs > 0) {
        await waitFor(delayTakeUpcomingByMs);
      }

      const now = Date.now();
      return deferredEvents.filter(
        (event) => event.lock === null && event.due <= now + 1000,
      );
    }),
    removeDeferredEvent: jest.fn(async (event) => {
      const index = deferredEvents.findIndex((item) => item.id === event.id);
      if (index >= 0) {
        deferredEvents.splice(index, 1);
      }
    }),
    releaseAllDeferredEvents: jest.fn(async () => {
      for (const event of deferredEvents) {
        event.lock = null;
      }
    }),
  } as unknown as PersistenceAdapter;
}

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
    timeExecution: jest.fn(async (_name, fn) => await fn()),
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

  it.skip('Schedules deferred events in the first batch', async () => {
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

      // @ts-expect-error Private access
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

      // @ts-expect-error Private access
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
      // @ts-expect-error Private access
      expect(deferredEventManager.deferredEventTimers.size).toBe(0);

      //expect(persistence.deferredEvents.rows.length).toBe(0);

      // @ts-expect-error Private access
      xJog.dying = true;

      // After the interval, a new attempt to read scheduled events from the
      // database is carried out. This time it should exit the loop, since the
      // flag of death is flying.
      await waitFor(interval);

      // @ts-expect-error Private access
      expect(deferredEventManager.deferredEventHandlerTimer).toBe(null);
    } finally {
      await deferredEventManager.releaseAll();
    }
  });

  it.skip('Schedules deferred events in a subsequent batch', async () => {
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
      // @ts-expect-error Private access
      expect(deferredEventManager.deferredEventTimers.size).toBe(0);

      // The next batch is read after the interval
      await waitFor(interval);

      // @ts-expect-error Private access
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

      // @ts-expect-error Private access
      expect(deferredEventManager.deferredEventTimers.size).toBe(1);

      // The event is sent after the remaining time
      await waitFor(delay - interval);

      expect(xJog.sendEvent).toHaveBeenCalledWith(
        ref,
        event,
        undefined,
        expect.stringMatching(/.+/),
      );

      // @ts-expect-error Private access
      xJog.dying = true;

      // Wait for the instance to die naturally
      await waitFor(interval);
    } finally {
      await deferredEventManager.releaseAll();
    }
  });

  it.skip('Cancels and removes the event when asked', async () => {
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
      // @ts-expect-error Private access
      expect(deferredEventManager.deferredEventTimers.size).toBe(1);

      //expect(persistence.deferredEvents.rows.length).toBe(1);

      await deferredEventManager.cancel('eventToBeCanceled');

      expect(deferredEventManager.deferredEventCount).toBe(0);
      // @ts-expect-error Private access
      expect(deferredEventManager.deferredEventTimers.size).toBe(0);

      //expect(persistence.deferredEvents.rows.length).toBe(0);

      // The event should not get sent
      await waitFor(delay);

      expect(xJog.sendEvent).not.toHaveBeenCalled();

      // @ts-expect-error Private access
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

      // @ts-expect-error Private access
      xJog.dying = true;
      // Call releaseAll as XJog.shutdown would
      await deferredEventManager.releaseAll();

      expect(deferredEventManager.deferredEventCount).toBe(0);
      // @ts-expect-error Private access
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

  it('does not let an ongoing scheduleUpcoming overwrite an earlier due-now wake-up', async () => {
    const persistence = createInMemoryPersistence(20);
    const [xJog, deferredEventManager] = mockXJogWithDeferredEventManager(
      persistence,
      {
        batchSize: 5,
        lookAhead: 1000,
        interval: 1000,
      },
    );

    try {
      const ref = { machineId: 'A', chartId: '1' };
      const event = toSCXMLEvent('event name');

      const scheduling = deferredEventManager.scheduleUpcoming();

      await waitFor(1);
      await deferredEventManager.defer({ eventId: 'e', ref, event, delay: 0 });
      await scheduling;

      await waitFor(50);

      expect(xJog.sendEvent).toHaveBeenCalledWith(
        ref,
        event,
        undefined,
        undefined,
        expect.stringMatching(/.+/),
      );
    } finally {
      // @ts-expect-error test-only shutdown flag
      xJog.dying = true;
      await deferredEventManager.releaseAll();
    }
  });

  it('does not overlap takeUpcomingDeferredEvents when scheduleUpcoming is called concurrently', async () => {
    let inFlightReads = 0;
    let maxInFlightReads = 0;
    let resolveFirstRead: (() => void) | undefined;
    let notifyFirstReadStarted: (() => void) | undefined;

    const firstReadStarted = new Promise<void>((resolve) => {
      notifyFirstReadStarted = resolve;
    });
    const firstReadCanFinish = new Promise<void>((resolve) => {
      resolveFirstRead = resolve;
    });

    const persistence = {
      deferEvent: jest.fn(),
      takeUpcomingDeferredEvents: jest.fn(async () => {
        inFlightReads += 1;
        maxInFlightReads = Math.max(maxInFlightReads, inFlightReads);

        try {
          if (notifyFirstReadStarted) {
            notifyFirstReadStarted();
            notifyFirstReadStarted = undefined;
            await firstReadCanFinish;
          }

          return [];
        } finally {
          inFlightReads -= 1;
        }
      }),
      removeDeferredEvent: jest.fn(),
      releaseAllDeferredEvents: jest.fn(),
    } as unknown as PersistenceAdapter;

    const [xJog, deferredEventManager] = mockXJogWithDeferredEventManager(
      persistence,
      {
        batchSize: 5,
        lookAhead: 1000,
        interval: 1000,
      },
    );

    try {
      const firstSchedule = deferredEventManager.scheduleUpcoming();
      await firstReadStarted;

      await deferredEventManager.scheduleUpcoming();

      expect(persistence.takeUpcomingDeferredEvents).toHaveBeenCalledTimes(1);
      expect(maxInFlightReads).toBe(1);

      resolveFirstRead!();
      await firstSchedule;

      await waitFor(25);

      expect(persistence.takeUpcomingDeferredEvents).toHaveBeenCalledTimes(2);
      expect(maxInFlightReads).toBe(1);
    } finally {
      // @ts-expect-error test-only shutdown flag
      xJog.dying = true;
      await deferredEventManager.releaseAll();
    }
  });

  describe('cancel with duplicate eventIds across chart instances', () => {
    it('removes only the entry for the specified chart ref, not another chart sharing the same eventId', async () => {
      const persistence = createInMemoryPersistence();
      const [xJog, deferredEventManager] = mockXJogWithDeferredEventManager(
        persistence,
        {
          batchSize: 5,
          lookAhead: 1000,
          interval: 1000,
        },
      );

      try {
        const sharedEventId = 'xstate.after(60000)#machine.state';
        const refA = { machineId: 'machine', chartId: 'chart-A' };
        const refB = { machineId: 'machine', chartId: 'chart-B' };
        const event = toSCXMLEvent({ type: sharedEventId });

        const entryA: any = {
          id: 101,
          ref: refA,
          eventId: sharedEventId,
          eventTo: null,
          event,
          timestamp: Date.now(),
          delay: 60000,
          due: Date.now() + 60000,
          lock: xJog.id,
        };
        const entryB: any = {
          id: 202,
          ref: refB,
          eventId: sharedEventId,
          eventTo: null,
          event,
          timestamp: Date.now(),
          delay: 60000,
          due: Date.now() + 60000,
          lock: xJog.id,
        };

        // Insert Chart B FIRST so it sits at index 0. Current buggy code
        // uses findIndex on eventId alone and will match this entry when
        // cancelling Chart A, removing the wrong one.
        // @ts-expect-error Private access
        deferredEventManager.deferredEvents.push(entryB, entryA);

        const timerA = setTimeout(() => {}, 99999);
        const timerB = setTimeout(() => {}, 99999);

        // @ts-expect-error Private access
        deferredEventManager.deferredEventTimers.set(entryA.id, timerA);
        // @ts-expect-error Private access
        deferredEventManager.deferredEventTimers.set(entryB.id, timerB);

        const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
        const removeDeferredEventSpy = jest.spyOn(
          persistence,
          'removeDeferredEvent',
        );

        try {
          // Cancel Chart A's after-timer. Without ref-scoping the code
          // matches by eventId alone and removes Chart B's entry instead.
          await deferredEventManager.cancel(sharedEventId, undefined, refA);

          // Chart B's entry must still be there.
          // @ts-expect-error Private access
          const remainingIds = deferredEventManager.deferredEvents.map(
            (e: any) => e.id,
          );
          expect(remainingIds).toContain(entryB.id);
          expect(remainingIds).not.toContain(entryA.id);

          // clearTimeout should have been called with Chart A's handle only.
          expect(clearTimeoutSpy).toHaveBeenCalledWith(timerA);
          expect(clearTimeoutSpy).not.toHaveBeenCalledWith(timerB);

          // persistence.removeDeferredEvent must target Chart A's row.
          expect(removeDeferredEventSpy).toHaveBeenCalledWith(
            expect.objectContaining({ id: entryA.id }),
            expect.anything(),
          );
          expect(removeDeferredEventSpy).not.toHaveBeenCalledWith(
            expect.objectContaining({ id: entryB.id }),
            expect.anything(),
          );
        } finally {
          clearTimeoutSpy.mockRestore();
          removeDeferredEventSpy.mockRestore();
          clearTimeout(timerA);
          clearTimeout(timerB);
        }
      } finally {
        // @ts-expect-error test-only shutdown flag
        xJog.dying = true;
        await deferredEventManager.releaseAll();
      }
    });

    it('guards the schedule() setTimeout callback against splicing -1 when the entry was already removed', async () => {
      jest.useFakeTimers();

      const persistence = createInMemoryPersistence();
      const [xJog, deferredEventManager] = mockXJogWithDeferredEventManager(
        persistence,
        {
          batchSize: 5,
          lookAhead: 1000,
          interval: 1000,
        },
      );

      try {
        const refX = { machineId: 'machine', chartId: 'chart-X' };
        const refY = { machineId: 'machine', chartId: 'chart-Y' };
        const event = toSCXMLEvent({ type: 'e' });

        const entryX: any = {
          id: 11,
          ref: refX,
          eventId: 'evt-x',
          eventTo: null,
          event,
          timestamp: Date.now(),
          delay: 10,
          due: Date.now() + 10,
          lock: xJog.id,
        };
        const entryY: any = {
          id: 22,
          ref: refY,
          eventId: 'evt-y',
          eventTo: null,
          event,
          timestamp: Date.now(),
          delay: 1000,
          due: Date.now() + 1000,
          lock: xJog.id,
        };

        // schedule X (this sets up the setTimeout whose callback is the one
        // we want to exercise) and then add Y to the list manually.
        // @ts-expect-error Private access
        deferredEventManager.schedule(entryX);
        // @ts-expect-error Private access
        deferredEventManager.deferredEvents.push(entryY);

        // Simulate a cancel-race: entry X was already removed from the list
        // before its own setTimeout fires.
        // @ts-expect-error Private access
        const xIndex = deferredEventManager.deferredEvents.findIndex(
          (e: any) => e.id === entryX.id,
        );
        // @ts-expect-error Private access
        deferredEventManager.deferredEvents.splice(xIndex, 1);

        // Now only Y remains. Fire X's timer.
        jest.advanceTimersByTime(10);
        // Flush any pending microtasks from the async setTimeout callback.
        await Promise.resolve();
        await Promise.resolve();

        // Y must still be in the list — buggy splice(-1, 1) would have
        // removed it as collateral damage.
        // @ts-expect-error Private access
        const remainingIds = deferredEventManager.deferredEvents.map(
          (e: any) => e.id,
        );
        expect(remainingIds).toContain(entryY.id);
      } finally {
        jest.useRealTimers();
        // @ts-expect-error test-only shutdown flag
        xJog.dying = true;
        await deferredEventManager.releaseAll();
      }
    });
  });
});

describe('XJogDeferredEventManager: ownership loss during deferred send', () => {
  it('unlocks the event for the owner instead of removing or keeping it locked', async () => {
    const persistence = createInMemoryPersistence();
    (persistence as any).releaseDeferredEvent = jest.fn(async () => {});

    // Short interval like the other tests: a leftover read timer fires once,
    // sees the dying flag set in the finally block, and stops — keeping the
    // event loop clean so jest can exit.
    const [xJog, deferredEventManager] = mockXJogWithDeferredEventManager(
      persistence,
      { batchSize: 5, lookAhead: 20, interval: 30 },
    );

    const ref = { machineId: 'A', chartId: '1' };
    const ownershipLost = new ChartOwnershipLostError(ref, 'xjog-id');
    (xJog.sendEvent as jest.Mock).mockRejectedValue(ownershipLost);

    try {
      await deferredEventManager.defer({
        eventId: 'e-7',
        ref,
        event: toSCXMLEvent('due now'),
        delay: 0,
      });

      // Read the due event and fire its timer.
      await deferredEventManager.scheduleUpcoming();
      await waitFor(50);

      expect(xJog.sendEvent).toHaveBeenCalled();

      // The chart belongs to another live instance now. This instance must
      // hand the event back (lock=NULL) so the owner's deferred loop can
      // fire it -- the reconciler only unlocks events of DEAD instances, so
      // keeping the lock would strand the timer forever.
      expect((persistence as any).releaseDeferredEvent).toHaveBeenCalledWith(
        ref,
        'e-7',
      );
      // And it must NOT be treated as delivered.
      expect(persistence.removeDeferredEvent).not.toHaveBeenCalled();
    } finally {
      // @ts-expect-error test-only shutdown flag
      xJog.dying = true;
      await deferredEventManager.releaseAll();
    }
  });
});
