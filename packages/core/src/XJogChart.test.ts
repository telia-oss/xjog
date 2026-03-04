import { PGlitePersistenceAdapter } from '@samihult/xjog-core-pglite';
import { Subject } from 'rxjs';
import { createMachine } from 'xstate';

import type { XJog } from './XJog';
import { XJogMachine } from './XJogMachine';

// PGlite initialisation can take several seconds
jest.setTimeout(30000);

/**
 * Build a minimal mock XJog instance that satisfies all fields accessed by
 * XJogChart.create() and XJogChart.send() without ever calling xJog.start().
 * Calling start() would kick off recurring timers (deferredEventManager,
 * persistence death-note polling) that keep the event loop alive and cause
 * Jest workers to hang.
 */
function buildMockXJog(persistence: PGlitePersistenceAdapter): XJog {
  const xJog: any = {
    id: 'test-xjog-instance',
    dying: false,
    persistence,
    // timeExecution just calls the routine immediately — same as production
    // but without any timing telemetry overhead
    timeExecution: <T>(_op: string, routine: () => T): T => routine(),
    simulator: { isEnabled: () => false },
    updateHooks: new Set<any>(),
    changeSubject: new Subject<any>(),
    activityManager: {
      sendAutoForwardEvent: jest.fn(),
      stopActivity: jest.fn(),
      stopAllForChart: jest.fn(),
      registerActivity: jest.fn(),
      activityOngoing: jest.fn().mockResolvedValue(false),
    },
    deferredEventManager: {
      defer: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
      cancelAllForChart: jest.fn().mockResolvedValue(undefined),
    },
    sendEvent: jest.fn().mockResolvedValue(null),
    // Logging — no-ops are fine
    log: jest.fn(),
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    emit: jest.fn(),
    options: {
      persistence,
      chartMutexTimeout: 2000,
      startup: {
        adoptionFrequency: 2000,
        gracePeriod: 30000,
        skipRunningActionsOnRehydrate: false,
      },
      deferredEvents: {
        batchSize: 100,
        interval: 30000,
        lookAhead: 30000,
      },
      shutdown: {
        ownChartPollingFrequency: 500,
      },
    },
  };

  return xJog as unknown as XJog;
}

describe('XJogChart: executeActions must run even if changeSubject.next() throws', () => {
  it('Calls executeActions after changeSubject.next() throws', async () => {
    const persistence = await PGlitePersistenceAdapter.connect();
    const xJog = buildMockXJog(persistence);

    // Minimal two-state machine: idle --(go)--> done
    const machine = createMachine({
      id: 'bug1-machine',
      initial: 'idle',
      states: {
        idle: { on: { go: 'done' } },
        done: { type: 'final' },
      },
    });

    const xJogMachine = new XJogMachine(xJog, machine);
    const chart = await xJogMachine.createChart();

    // Force changeSubject.next() to throw so we can verify executeActions
    // is still reached. This is the core regression scenario for a bug fixed:
    // if the error propagates out of changeSubject.next(), executeActions
    // is skipped and the chart ends up with unexecuted persisted actions
    // (e.g. xstate.send delayed transitions).
    jest.spyOn(xJog.changeSubject, 'next').mockImplementationOnce(() => {
      throw new Error('Simulated subscriber error');
    });

    // @ts-expect-error Private access
    const executeActionsSpy = jest.spyOn(chart, 'executeActions');

    await chart.send('go');

    expect(executeActionsSpy).toHaveBeenCalled();
  });

  it('Returns the new state even when changeSubject.next() throws', async () => {
    const persistence = await PGlitePersistenceAdapter.connect();
    const xJog = buildMockXJog(persistence);

    const machine = createMachine({
      id: 'bug1-machine-return',
      initial: 'idle',
      states: {
        idle: { on: { go: 'done' } },
        done: { type: 'final' },
      },
    });

    const xJogMachine = new XJogMachine(xJog, machine);
    const chart = await xJogMachine.createChart();

    // Without the Bug 1 fix, a throwing subscriber would cause the outer
    // catch block in send() to swallow the error and return null. The fix
    // isolates changeSubject.next() so send() returns the new state.
    jest.spyOn(xJog.changeSubject, 'next').mockImplementationOnce(() => {
      throw new Error('Simulated subscriber error');
    });

    const result = await chart.send('go');

    expect(result).not.toBeNull();
    expect(result?.value).toBe('done');
  });
});
