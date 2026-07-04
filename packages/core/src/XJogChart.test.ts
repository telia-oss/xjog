import { ChartOwnershipLostError } from '@telia-oss/xjog-core-persistence';
import type { PGlitePersistenceAdapter } from '@telia-oss/xjog-core-pglite';
import { Subject } from 'rxjs';
import { createMachine, interpret, State } from 'xstate';
import { connectTestPersistence } from './pglite.testutil';
import type { XJog } from './XJog';
import { XJogChart } from './XJogChart';
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
    // Mirrors XJog.runUpdateHooks: best-effort per-hook invocation that
    // catches both synchronous throws and rejections.
    runUpdateHooks: async (
      change: any,
      _label: string,
      onError: (err: unknown) => void,
    ): Promise<void> => {
      for (const hook of xJog.updateHooks) {
        await Promise.resolve()
          .then(() => hook(change))
          .catch(onError);
      }
    },
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
    const persistence = await connectTestPersistence();
    const xJog = buildMockXJog(persistence);

    // Minimal two-state machine: idle --(go)--> done
    const machine = createMachine({
      // xstate v4 default; set explicitly on every test machine to silence the
      // recommendation warning. Left false so these tests keep exercising the
      // default xstate v4 after-action behavior XJog handles in production.
      predictableActionArguments: false,
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

    const executeActionsSpy = jest.spyOn(chart, 'executeActions');

    await chart.send('go');

    expect(executeActionsSpy).toHaveBeenCalled();
  });

  it('Returns the new state even when changeSubject.next() throws', async () => {
    const persistence = await connectTestPersistence();
    const xJog = buildMockXJog(persistence);

    const machine = createMachine({
      predictableActionArguments: false,
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

describe('XJogChart missing after repair', () => {
  it('reconstructs missing after-actions when deferred row is absent', async () => {
    const persistence = await connectTestPersistence();
    const xJog = buildMockXJog(persistence);

    const machine = createMachine({
      predictableActionArguments: false,
      id: 'rehydrate-after-machine',
      initial: 'waiting',
      states: {
        waiting: {
          after: {
            1000: 'done',
          },
        },
        done: {
          type: 'final',
        },
      },
    });

    const xJogMachine = new XJogMachine(xJog, machine);
    const service = interpret(machine).start();
    const resolvedState = machine.resolveState(
      State.create(JSON.parse(JSON.stringify(service.state))),
    );

    (xJogMachine.persistence as any).isDeferredEventPresent = jest
      .fn()
      .mockResolvedValue(false);

    // @ts-expect-error Testing private helper intentionally
    const repairedActions = await XJogChart.resolveMissingAfterActions(
      xJogMachine,
      'chart-with-after',
      resolvedState,
    );

    expect(
      repairedActions.some(
        (action) =>
          action.type === 'xstate.send' &&
          action.id === 'xstate.after(1000)#rehydrate-after-machine.waiting',
      ),
    ).toBe(true);
  });

  it('executes reconstructed after-actions during runStep even when rehydrate actions are skipped', async () => {
    const persistence = await connectTestPersistence();
    const xJog = buildMockXJog(persistence);
    xJog.options.startup.skipRunningActionsOnRehydrate = true;

    const machine = createMachine({
      predictableActionArguments: false,
      id: 'rehydrate-runstep-machine',
      initial: 'waiting',
      states: {
        waiting: {
          after: {
            1000: 'done',
          },
        },
        done: {
          type: 'final',
        },
      },
    });

    const xJogMachine = new XJogMachine(xJog, machine);
    const chart = await xJogMachine.createChart({
      chartId: 'chart-runstep-after',
    });

    (xJogMachine.persistence as any).isDeferredEventPresent = jest
      .fn()
      .mockResolvedValue(false);

    const deferSpy = jest.spyOn(xJog.deferredEventManager, 'defer');

    await chart.runStep();

    expect(deferSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'xstate.after(1000)#rehydrate-runstep-machine.waiting',
      }),
      expect.any(String),
    );
  });

  it('reconstructs after-action when the delay is a named delay with a numeric entry in machine.options.delays', async () => {
    const persistence = await connectTestPersistence();
    const xJog = buildMockXJog(persistence);

    const machine = createMachine(
      {
        predictableActionArguments: false,
        id: 'named-delay-number-machine',
        initial: 'waiting',
        states: {
          waiting: {
            after: {
              'check interval': 'done',
            },
          },
          done: { type: 'final' },
        },
      },
      {
        delays: {
          'check interval': 60000,
        },
      },
    );

    const xJogMachine = new XJogMachine(xJog, machine);
    const service = interpret(machine).start();
    const resolvedState = machine.resolveState(
      State.create(JSON.parse(JSON.stringify(service.state))),
    );

    (xJogMachine.persistence as any).isDeferredEventPresent = jest
      .fn()
      .mockResolvedValue(false);

    // @ts-expect-error Testing private helper intentionally
    const repairedActions = await XJogChart.resolveMissingAfterActions(
      xJogMachine,
      'chart-named-delay-number',
      resolvedState,
    );

    const afterAction = repairedActions.find(
      (action: any) =>
        action.id ===
        'xstate.after(check interval)#named-delay-number-machine.waiting',
    );
    expect(afterAction).toBeDefined();
    expect((afterAction as any).delay).toBe(60000);
  });

  it('reconstructs after-action when the delay resolver is a function of context', async () => {
    const persistence = await connectTestPersistence();
    const xJog = buildMockXJog(persistence);

    const machine = createMachine<{ intervalMs: number }>(
      {
        predictableActionArguments: false,
        id: 'named-delay-function-machine',
        initial: 'waiting',
        context: { intervalMs: 45000 },
        states: {
          waiting: {
            after: {
              'check interval': 'done',
            },
          },
          done: { type: 'final' },
        },
      },
      {
        delays: {
          'check interval': (ctx) => ctx.intervalMs,
        },
      },
    );

    const xJogMachine = new XJogMachine(xJog, machine);
    const service = interpret(machine).start();
    const resolvedState = machine.resolveState(
      State.create(JSON.parse(JSON.stringify(service.state))),
    );

    (xJogMachine.persistence as any).isDeferredEventPresent = jest
      .fn()
      .mockResolvedValue(false);

    // @ts-expect-error Testing private helper intentionally
    const repairedActions = await XJogChart.resolveMissingAfterActions(
      xJogMachine,
      'chart-named-delay-function',
      resolvedState,
    );

    const afterAction = repairedActions.find(
      (action: any) =>
        action.id ===
        'xstate.after(check interval)#named-delay-function-machine.waiting',
    );
    expect(afterAction).toBeDefined();
    expect((afterAction as any).delay).toBe(45000);
  });

  it('does not reconstruct an after-action when the named delay has no matching entry in machine.options.delays', async () => {
    const persistence = await connectTestPersistence();
    const xJog = buildMockXJog(persistence);

    const machine = createMachine({
      predictableActionArguments: false,
      id: 'unresolvable-named-delay-machine',
      initial: 'waiting',
      states: {
        waiting: {
          after: {
            'check interval': 'done',
          },
        },
        done: { type: 'final' },
      },
    });

    const xJogMachine = new XJogMachine(xJog, machine);
    // Starting this machine makes xstate warn that the named delay
    // 'check interval' has no matching entry in machine.options.delays — which
    // is precisely the condition under test. Suppress the expected warning so
    // it doesn't pollute the test output.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const service = interpret(machine).start();
    warnSpy.mockRestore();
    const resolvedState = machine.resolveState(
      State.create(JSON.parse(JSON.stringify(service.state))),
    );

    (xJogMachine.persistence as any).isDeferredEventPresent = jest
      .fn()
      .mockResolvedValue(false);

    // @ts-expect-error Testing private helper intentionally
    const repairedActions = await XJogChart.resolveMissingAfterActions(
      xJogMachine,
      'chart-unresolvable-named-delay',
      resolvedState,
    );

    expect(
      repairedActions.some(
        (action: any) =>
          typeof action.id === 'string' &&
          action.id.startsWith('xstate.after(check interval)'),
      ),
    ).toBe(false);
  });
});

describe('XJogChart: named delay on re-entry after parallel onDone', () => {
  it('re-schedules the named after-timer with the resolved numeric delay on the second entry into waiting', async () => {
    const persistence = await connectTestPersistence();
    const xJog = buildMockXJog(persistence);

    // Simplified reproduction of the poll-machine shape we see in production:
    //   idle --(go)--> waiting --(after 'check interval')--> buffering (parallel)
    //   buffering (both branches reach `done` via `always`) --(onDone)--> waiting
    // The bug: on the second entry into `waiting` (via parallel onDone), xstate
    // v4 does not run resolveSend on the generated after-action, so
    // `action.delay` remains the string 'check interval' instead of being
    // resolved to 60000 via machine.options.delays.
    const machine = createMachine(
      {
        predictableActionArguments: false,
        id: 'poll',
        initial: 'idle',
        states: {
          idle: { on: { go: 'waiting' } },
          waiting: {
            after: { 'check interval': 'buffering' },
          },
          buffering: {
            type: 'parallel',
            states: {
              a: {
                initial: 'x',
                states: {
                  x: { always: { target: 'done' } },
                  done: { type: 'final' },
                },
              },
              b: {
                initial: 'x',
                states: {
                  x: { always: { target: 'done' } },
                  done: { type: 'final' },
                },
              },
            },
            onDone: { target: 'waiting' },
          },
        },
      },
      {
        delays: {
          'check interval': 60000,
        },
      },
    );

    const xJogMachine = new XJogMachine(xJog, machine);
    const chart = await xJogMachine.createChart();

    const deferSpy = xJog.deferredEventManager.defer as jest.Mock;

    // --- First cycle: go -> waiting. The after-action here is known to work. ---
    await chart.send('go');

    const firstCycleDeferCalls = deferSpy.mock.calls.filter(([persisted]) => {
      return (
        typeof persisted?.eventId === 'string' &&
        persisted.eventId.startsWith('xstate.after(check interval)')
      );
    });

    // Sanity: the first entry into `waiting` must have scheduled the after-timer
    // with the resolved numeric delay. If this assertion fails, the bug is not
    // what we think — the wiring is broken instead.
    expect(firstCycleDeferCalls.length).toBeGreaterThanOrEqual(1);
    expect(firstCycleDeferCalls[0][0].delay).toBe(60000);

    // --- Second cycle: simulate the timer firing. ---
    // waiting --(xstate.after(check interval))--> buffering
    //   -> parallel `always` transitions resolve synchronously to `done`
    //   -> onDone targets waiting -> waiting re-entered
    //   -> new xstate.after(check interval) should be scheduled.
    deferSpy.mockClear();

    await chart.send({
      type: 'xstate.after(check interval)#poll.waiting',
    } as any);

    const secondCycleDeferCalls = deferSpy.mock.calls.filter(([persisted]) => {
      return (
        typeof persisted?.eventId === 'string' &&
        persisted.eventId.startsWith('xstate.after(check interval)')
      );
    });

    // The bug surfaces here: either no defer call is made at all, OR it is
    // made with a non-numeric (string) delay. Either way, the chart will not
    // re-poll correctly.
    expect(secondCycleDeferCalls.length).toBeGreaterThanOrEqual(1);
    expect(secondCycleDeferCalls[0][0].delay).toBe(60000);
    // Explicitly check the delay type — if xstate fails to resolve a named
    // delay on the re-entry path, it would leak the string 'check interval'.
    expect(typeof secondCycleDeferCalls[0][0].delay).toBe('number');
  });
});

describe('XJogChart: ownership fencing on state writes', () => {
  it('refuses to overwrite a chart another instance owns and evicts it from the cache', async () => {
    const persistence = await connectTestPersistence();
    const xJog = buildMockXJog(persistence);

    const machine = createMachine({
      predictableActionArguments: false,
      id: 'fencing-machine',
      initial: 'idle',
      states: {
        idle: { on: { go: 'done' } },
        done: { type: 'final' },
      },
    });

    const xJogMachine = new XJogMachine(xJog, machine);
    const chart = await xJogMachine.createChart();

    // A sibling instance adopts the chart behind this instance's back
    // (stale-instance takeover while this event loop was wedged).
    await persistence.withTransaction(async (client) => {
      await client.query('UPDATE "charts" SET "ownerId" = $1', ['usurper']);
    });

    // The fenced write must not go through. Ownership loss is an expected,
    // self-correcting handoff condition, so send() surfaces it as a DISTINCT
    // error — not the generic null — letting callers skip failure accounting
    // and ask their client to retry.
    let thrown: unknown;
    try {
      await chart.send('go');
    } catch (error) {
      thrown = error;
    }
    expect(ChartOwnershipLostError.is(thrown)).toBe(true);

    // The persisted state is untouched — still the owner's version.
    const persisted = await persistence.withTransaction(async (client) =>
      client.query<{ ownerId: string; state: Uint8Array }>(
        'SELECT "ownerId", "state" FROM "charts"',
      ),
    );
    expect(persisted.rows[0].ownerId).toBe('usurper');
    const persistedState = JSON.parse(
      Buffer.from(persisted.rows[0].state).toString('utf-8'),
    );
    expect(persistedState.value).toBe('idle');

    // The stale chart object is evicted so the next getChart reloads from
    // the database instead of serving the poisoned in-memory copy.
    // Eviction is asynchronous (it waits for the send mutex to release).
    await new Promise((resolve) => setTimeout(resolve, 100));
    const reloaded = await xJogMachine.getChart(chart.id);
    expect(reloaded).not.toBe(chart);
  });
});

describe('ChartOwnershipLostError.is', () => {
  const ref = { machineId: 'm', chartId: 'c' };

  it('recognizes a real instance', () => {
    expect(
      ChartOwnershipLostError.is(new ChartOwnershipLostError(ref, 'i')),
    ).toBe(true);
  });

  it('recognizes a same-named error from a duplicated package instance', () => {
    // pnpm can resolve two copies of xjog-core-persistence into a consumer's
    // tree; instanceof fails across them, so the guard matches by name.
    const foreign = new Error('lost');
    foreign.name = 'ChartOwnershipLostError';
    expect(ChartOwnershipLostError.is(foreign)).toBe(true);
  });

  it('rejects other errors and non-errors', () => {
    expect(ChartOwnershipLostError.is(new Error('nope'))).toBe(false);
    expect(ChartOwnershipLostError.is(null)).toBe(false);
    expect(ChartOwnershipLostError.is(undefined)).toBe(false);
    expect(ChartOwnershipLostError.is('ChartOwnershipLostError')).toBe(false);
  });
});

describe('XJogChart.destroy with a failing update hook', () => {
  // Regression: destroy() ran hooks and destroyChart outside try/finally
  // and without per-hook error handling, so one throwing hook aborted the
  // destroy, left the persisted chart in place, and never released the
  // chart mutex, wedging every later operation on the chart
  it('destroys the chart and releases the mutex even if a hook throws', async () => {
    const persistence = await connectTestPersistence();
    const xJog = buildMockXJog(persistence);

    xJog.updateHooks.add(() => {
      throw new Error('Simulated hook failure');
    });

    const machine = createMachine({
      predictableActionArguments: false,
      id: 'destroy-hook-machine',
      initial: 'idle',
      states: { idle: {} },
    });

    const xJogMachine = new XJogMachine(xJog, machine);
    const chart = await xJogMachine.createChart();

    await expect(chart.destroy()).resolves.toBeUndefined();

    expect(await persistence.isChartPresent(chart.ref)).toBe(false);
    expect(chart.chartMutex.isLocked()).toBe(false);
  });
});

describe('XJogChart done-data resolution', () => {
  // Regression: resolveDoneData() returns a Promise (its body runs through
  // timeExecution's async wrapper), but send() passed the return value into
  // doneInvoke() without awaiting, so the parent chart received a Promise
  // object as the done event's data instead of the mapped value
  it('sends the resolved done data to the parent, not a Promise', async () => {
    const persistence = await connectTestPersistence();
    const xJog = buildMockXJog(persistence);

    const machine = createMachine({
      predictableActionArguments: false,
      id: 'done-data-machine',
      initial: 'working',
      context: { answer: 42 },
      states: {
        working: { on: { finish: 'done' } },
        done: {
          type: 'final',
          data: (context: { answer: number }) => ({ result: context.answer }),
        },
      },
    });

    const xJogMachine = new XJogMachine(xJog, machine);
    const parentRef = { machineId: 'parent-machine', chartId: 'parent-chart' };
    const chart = await xJogMachine.createChart({ parentRef });

    await chart.send('finish');

    expect(xJog.sendEvent).toHaveBeenCalledTimes(1);
    const [sentRef, sentEvent] = (xJog.sendEvent as jest.Mock).mock.calls[0];
    expect(sentRef).toEqual(parentRef);
    expect(sentEvent.type).toBe(`done.invoke.${chart.id}`);
    expect(sentEvent.data).toEqual({ result: 42 });
    expect(typeof (sentEvent.data as any)?.then).not.toBe('function');
  });

  // Regression: the done-notification block was awaited outside send()'s
  // try/catch, so a throwing final-state `data` mapper rejected send() after
  // the transition was already committed and the mutex released — reporting a
  // hard failure for a transition that actually succeeded. It must degrade to
  // a logged best-effort skip instead.
  it('does not reject send() when the final-state data mapper throws', async () => {
    const persistence = await connectTestPersistence();
    const xJog = buildMockXJog(persistence);

    const machine = createMachine({
      predictableActionArguments: false,
      id: 'done-data-throw-machine',
      initial: 'working',
      states: {
        working: { on: { finish: 'done' } },
        done: {
          type: 'final',
          data: () => {
            throw new Error('Simulated done-data failure');
          },
        },
      },
    });

    const xJogMachine = new XJogMachine(xJog, machine);
    const parentRef = { machineId: 'parent-machine', chartId: 'parent-chart' };
    const chart = await xJogMachine.createChart({ parentRef });

    const result = await chart.send('finish');

    // send() resolves with the (committed) final state rather than rejecting,
    // and the parent notification is skipped rather than sent with bad data.
    expect(result?.done).toBe(true);
    expect(xJog.sendEvent).not.toHaveBeenCalled();
    expect(chart.chartMutex.isLocked()).toBe(false);
  });
});
