import { PGlitePersistenceAdapter } from '@samihult/xjog-core-pglite';
import { createMachine } from 'xstate';

import { XJog } from './XJog';

/**
 * Reject if the promise does not settle within `ms`. Used so that a regression
 * (an infinite adoption wait in shutdown) surfaces as a fast, clear test
 * failure instead of hanging the whole runner until the jest timeout.
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
  id: 'shutdown-machine',
  initial: 'idle',
  states: {
    idle: {},
    done: { type: 'final' },
  },
});

describe('XJog.shutdown: lone instance must not hang', () => {
  it('resolves and emits halt even while owning charts with no successor', async () => {
    const persistence = await PGlitePersistenceAdapter.connect();
    const xJog = new XJog({ persistence });

    const xJogMachine = await xJog.registerMachine(machine);
    await xJog.start();

    // Own a chart so the adoption wait loop is genuinely entered. Without an
    // owned chart the loop body never runs and the hang would not reproduce.
    await xJogMachine.createChart();
    expect(await persistence.countOwnCharts(xJog.id)).toBeGreaterThan(0);

    const halted = xJog.waitUntilHalted();

    // Regression: removeInstance used to be a no-op, so the departing instance
    // still counted itself alive (instanceCount > 0) and waited forever for a
    // successor that never comes. With the fix it deregisters itself,
    // countAliveInstances drops to 0 and the wait is skipped entirely.
    await withTimeout(xJog.shutdown(), 5000, 'lone shutdown to resolve');
    await withTimeout(halted, 1000, 'halt event');

    // The chart is left persisted for the next instance to adopt on boot.
    expect(await persistence.countOwnCharts(xJog.id)).toBeGreaterThan(0);
  }, 10000);
});

describe('XJog.shutdown: bounded adoption wait (adoptionTimeout)', () => {
  it('proceeds to halt after adoptionTimeout when no one adopts the charts', async () => {
    const persistence = await PGlitePersistenceAdapter.connect();
    const xJog = new XJog({
      persistence,
      shutdown: { adoptionTimeout: 300, ownChartPollingFrequency: 50 },
    });

    const xJogMachine = await xJog.registerMachine(machine);
    await xJog.start();
    await xJogMachine.createChart();

    // Simulate another live instance so instanceCount > 0 and the wait runs,
    // but nobody actually adopts this instance's charts — exercising the
    // timeout path rather than the lone-instance fast path.
    await persistence.withTransaction(async (client) => {
      await client.query(
        'INSERT INTO "instances" ("instanceId", "dying") VALUES ($1, FALSE)',
        ['phantom-successor'],
      );
    });
    expect(await persistence.countAliveInstances()).toBeGreaterThan(1);

    const halted = xJog.waitUntilHalted();

    const before = Date.now();
    await withTimeout(xJog.shutdown(), 5000, 'bounded shutdown to resolve');
    await withTimeout(halted, 1000, 'halt event');
    const elapsed = Date.now() - before;

    // It waited (did not exit immediately) but did not hang past the timeout.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(4000);
    // Charts remain owned by this instance — handoff was skipped, not lost.
    expect(await persistence.countOwnCharts(xJog.id)).toBeGreaterThan(0);
  }, 10000);
});
