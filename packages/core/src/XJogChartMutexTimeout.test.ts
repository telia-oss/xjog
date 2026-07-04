import { createMachine } from 'xstate';

import { connectTestPersistence } from './pglite.testutil';

import { XJog } from './XJog';

/**
 * Reject if the promise does not settle within `ms`, so a regression surfaces
 * as a fast, clear test failure instead of hanging the runner.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out waiting for: ${label}`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const machine = createMachine({
  // xstate v4 default; set explicitly to silence the recommendation warning
  // without changing behavior.
  predictableActionArguments: false,
  id: 'mutex-timeout-machine',
  initial: 'idle',
  states: {
    idle: {
      on: { PING: 'idle' },
    },
  },
});

describe('XJogChart mutex acquire timeout', () => {
  it('fails the blocked operation without shutting down the engine', async () => {
    const persistence = await connectTestPersistence();
    const xJog = new XJog({ persistence, chartMutexTimeout: 150 });

    const xJogMachine = await xJog.registerMachine(machine);
    await xJog.start();
    const chart = await xJogMachine.createChart();

    // Wedge the chart: update hooks run while the chart mutex is held, so a
    // hook that never settles keeps the mutex locked for the first send.
    let releaseHook!: () => void;
    let hookEntered!: () => void;
    const hookHeld = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const hookEnteredPromise = new Promise<void>((resolve) => {
      hookEntered = resolve;
    });
    const uninstallHook = xJog.installUpdateHook(() => {
      hookEntered();
      return hookHeld;
    });

    const blockedSend = chart.send('PING');
    await withTimeout(hookEnteredPromise, 2000, 'first send to hold mutex');

    // Regression: acquireMutex used to react to the timeout by shutting down
    // the WHOLE engine (xJog.dying = true), after which every send on every
    // chart was silently deferred and returned null while the process kept
    // running. The timeout must fail only the blocked operation.
    await expect(chart.send('PING')).rejects.toThrow(/Failed to acquire mutex/);
    expect(xJog.dying).toBe(false);

    releaseHook();
    uninstallHook();
    await withTimeout(blockedSend, 2000, 'mutex-holding send to finish');

    // The engine is still fully operational: the same chart accepts events.
    const state = await withTimeout(
      chart.send('PING'),
      2000,
      'send after mutex timeout',
    );
    expect(state).not.toBeNull();

    await withTimeout(xJog.shutdown(), 5000, 'shutdown');
  }, 15000);
});
