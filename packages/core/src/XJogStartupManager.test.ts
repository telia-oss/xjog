import type { PersistenceAdapter } from '@samihult/xjog-core-persistence';
import { connectTestPersistence } from './pglite.testutil';
import type { XJog } from './XJog';
import { XJogStartupManager } from './XJogStartupManager';

function mockXJogWithStartupManager(
  persistence: PersistenceAdapter,
  trace = false,
): [XJog, XJogStartupManager] {
  const xJog: any = {
    id: 'xjog-id',
    persistence,
    trace: trace ? console.log : () => {},
    error: trace ? console.error : () => {},
    emit: jest.fn(),
    options: {
      startup: {
        adoptionFrequency: 20,
        gracePeriod: 75,
        instanceStaleness: 60_000,
      },
    },
  };

  xJog.startupManager = new XJogStartupManager(xJog);

  return [xJog as unknown as XJog, xJog.startupManager];
}

async function waitFor(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe('XJogStartupManager', () => {
  it('Is initially idle, not started and not finished', async () => {
    const persistence = await connectTestPersistence();
    const [, startupManager] = mockXJogWithStartupManager(persistence);

    expect(startupManager.started).toBe(false);
    expect(startupManager.ready).toBe(false);
  });

  it('Become ready right after the startup sequence when nothing to adopt', async () => {
    const persistence = await connectTestPersistence();
    const [, startupManager] = mockXJogWithStartupManager(persistence);

    await startupManager.start();

    expect(startupManager.started).toBe(true);
    expect(startupManager.ready).toBe(true);

    // The reconciler loop runs until stopped; clean it up so jest can exit.
    await startupManager.stop();
  });

  it('Executes the right routines during the startup', async () => {
    const persistence = await connectTestPersistence();
    const [, startupManager] = mockXJogWithStartupManager(persistence);

    jest.spyOn(persistence, 'registerInstance');
    jest.spyOn(persistence, 'overthrowOtherInstances');
    // @ts-expect-error Private access
    jest.spyOn(startupManager, 'startAdoptionGracePeriod');
    // @ts-expect-error Private access
    jest.spyOn(startupManager, 'adoptCharts');

    await startupManager.start();

    // Non-violent boot: register self, never stage a coup against siblings.
    expect(persistence.registerInstance).toHaveBeenCalled();
    expect(persistence.overthrowOtherInstances).not.toHaveBeenCalled();
    // @ts-expect-error Private access
    expect(startupManager.startAdoptionGracePeriod).toHaveBeenCalled();
    // @ts-expect-error Private access
    expect(startupManager.adoptCharts).toHaveBeenCalled();

    await startupManager.stop();
  });
});

describe('XJogStartupManager: live handoff', () => {
  async function seedInstance(
    persistence: PersistenceAdapter,
    id: string,
    ageSeconds = 0,
  ): Promise<void> {
    await persistence.withTransaction(async (client: any) => {
      await client.query(
        `INSERT INTO "instances" ("instanceId", "dying", "timestamp")
         VALUES ($1, FALSE, now() - make_interval(secs => $2))`,
        [id, ageSeconds],
      );
    });
  }

  async function seedChart(
    persistence: PersistenceAdapter,
    chartId: string,
    ownerId: string,
    paused = false,
  ): Promise<void> {
    await persistence.withTransaction(async (client: any) => {
      await client.query(
        `INSERT INTO "charts"
           ("machineId", "chartId", "ownerId", "paused", "state")
         VALUES ('machine', $1, $2, $3, decode('7b7d', 'hex'))`,
        [chartId, ownerId, paused],
      );
    });
  }

  async function readCharts(
    persistence: PersistenceAdapter,
  ): Promise<Array<{ chartId: string; ownerId: string; paused: boolean }>> {
    const result = await persistence.withTransaction(async (client: any) =>
      client.query(
        'SELECT "chartId", "ownerId", "paused" FROM "charts" ORDER BY "chartId"',
      ),
    );
    return (result as any).rows;
  }

  async function readInstances(
    persistence: PersistenceAdapter,
  ): Promise<Array<{ instanceId: string; dying: boolean }>> {
    const result = await persistence.withTransaction(async (client: any) =>
      client.query(
        'SELECT "instanceId", "dying" FROM "instances" ORDER BY "instanceId"',
      ),
    );
    return (result as any).rows;
  }

  it('Boot leaves a live sibling and its charts untouched', async () => {
    const persistence = await connectTestPersistence();
    const [, startupManager] = mockXJogWithStartupManager(persistence);

    await seedInstance(persistence, 'sibling');
    await seedChart(persistence, 'sibling-chart', 'sibling');

    await startupManager.start();

    expect(await readInstances(persistence)).toEqual([
      { instanceId: 'sibling', dying: false },
      { instanceId: 'xjog-id', dying: false },
    ]);
    expect(await readCharts(persistence)).toEqual([
      { chartId: 'sibling-chart', ownerId: 'sibling', paused: false },
    ]);
    // Nothing to adopt, so the boot is immediately ready.
    expect(startupManager.ready).toBe(true);

    await startupManager.stop();
  });

  it('Reconciler adopts charts paused by a departing sibling after readiness', async () => {
    const persistence = await connectTestPersistence();
    const [xJog, startupManager] = mockXJogWithStartupManager(persistence);

    const runStep = jest.fn().mockResolvedValue(undefined);
    (xJog as any).getChart = jest.fn().mockResolvedValue({ runStep });

    await startupManager.start();
    expect(startupManager.ready).toBe(true);

    // A sibling drains and pauses its chart AFTER our startup completed.
    await seedChart(persistence, 'handed-over', 'departed-sibling', true);

    await waitFor(200); // several reconciler cycles at 20ms

    expect(await readCharts(persistence)).toEqual([
      { chartId: 'handed-over', ownerId: 'xjog-id', paused: false },
    ]);
    expect(runStep).toHaveBeenCalled();

    await startupManager.stop();
  });

  it('Reconciler marks a stale sibling dying and adopts its charts', async () => {
    const persistence = await connectTestPersistence();
    const [xJog, startupManager] = mockXJogWithStartupManager(persistence);
    (xJog as any).options.startup.instanceStaleness = 50;

    const runStep = jest.fn().mockResolvedValue(undefined);
    (xJog as any).getChart = jest.fn().mockResolvedValue({ runStep });

    // Crashed sibling: alive row with an ancient heartbeat, unpaused chart.
    await seedInstance(persistence, 'crashed-sibling', 3600);
    await seedChart(persistence, 'stranded-chart', 'crashed-sibling');

    await startupManager.start();
    await waitFor(200);

    const instances = await readInstances(persistence);
    expect(instances).toContainEqual({
      instanceId: 'crashed-sibling',
      dying: true,
    });
    expect(await readCharts(persistence)).toEqual([
      { chartId: 'stranded-chart', ownerId: 'xjog-id', paused: false },
    ]);

    await startupManager.stop();
  });

  it('Reconciler heartbeats the own instance row', async () => {
    const persistence = await connectTestPersistence();
    const [, startupManager] = mockXJogWithStartupManager(persistence);

    await startupManager.start();

    // Age the own row artificially; the next cycles must refresh it.
    await persistence.withTransaction(async (client: any) => {
      await client.query(
        `UPDATE "instances" SET "timestamp" = now() - interval '1 hour'
         WHERE "instanceId" = 'xjog-id'`,
      );
    });

    await waitFor(100);

    const result = await persistence.withTransaction(async (client: any) =>
      client.query(
        `SELECT extract(epoch from now() - "timestamp") AS "ageSeconds"
         FROM "instances" WHERE "instanceId" = 'xjog-id'`,
      ),
    );
    expect(Number((result as any).rows[0].ageSeconds)).toBeLessThan(5);

    await startupManager.stop();
  });
});

describe('XJogStartupManager: grace period timer must not reset on every cycle', () => {
  it('Does not restart the grace period timer when it is already running', async () => {
    const persistence = await connectTestPersistence();
    const [, startupManager] = mockXJogWithStartupManager(persistence);

    // @ts-expect-error Private access
    jest.spyOn(startupManager, 'startAdoptionGracePeriod');

    // Simulate a paused chart so adoptCharts enters the "more to adopt" branch
    jest.spyOn(persistence, 'gentlyAdoptCharts').mockResolvedValue([]);
    jest.spyOn(persistence, 'getPausedChartCount').mockResolvedValue(1);

    // Pre-set the grace period timer to simulate it already being active.
    // Without the fix, startAdoptionGracePeriod() would be called
    // unconditionally, resetting the 30s countdown on every 2s cycle.
    // @ts-expect-error Private access
    startupManager.startupGracePeriodTimer = setTimeout(() => {}, 99999);

    // @ts-expect-error Private access
    await startupManager.adoptCharts();

    // The grace period timer was already running, so startAdoptionGracePeriod
    // must NOT have been called again (that would reset the 30s countdown).
    // @ts-expect-error Private access
    expect(startupManager.startAdoptionGracePeriod).not.toHaveBeenCalled();

    // Clean up the timers we set
    // @ts-expect-error Private access
    clearTimeout(startupManager.startupGracePeriodTimer);
    // @ts-expect-error Private access
    clearTimeout(startupManager.adoptionLoopTimer);
  });

  it('Starts the grace period timer on the first adoption cycle when charts remain', async () => {
    const persistence = await connectTestPersistence();
    const [, startupManager] = mockXJogWithStartupManager(persistence);

    // @ts-expect-error Private access
    jest.spyOn(startupManager, 'startAdoptionGracePeriod');

    jest.spyOn(persistence, 'gentlyAdoptCharts').mockResolvedValue([]);
    jest.spyOn(persistence, 'getPausedChartCount').mockResolvedValue(1);

    // No pre-existing timer — grace period should be started exactly once
    // @ts-expect-error Private access
    await startupManager.adoptCharts();

    // @ts-expect-error Private access
    expect(startupManager.startAdoptionGracePeriod).toHaveBeenCalledTimes(1);

    // Clean up timers
    // @ts-expect-error Private access
    clearTimeout(startupManager.startupGracePeriodTimer);
    // @ts-expect-error Private access
    clearTimeout(startupManager.adoptionLoopTimer);
  });
});

describe('XJogStartupManager.startAdoptedCharts: missing-after-timer repair', () => {
  it('calls runStep on each adopted chart even when skipRunningActionsOnRehydrate=true', async () => {
    const persistence = await connectTestPersistence();
    const [xJog, startupManager] = mockXJogWithStartupManager(persistence);

    xJog.options.startup.skipRunningActionsOnRehydrate = true;

    const runStep = jest.fn().mockResolvedValue(undefined);
    (xJog as unknown as { getChart: jest.Mock }).getChart = jest
      .fn()
      .mockResolvedValue({ runStep });

    const refs = [
      { machineId: 'm', chartId: 'c1' },
      { machineId: 'm', chartId: 'c2' },
    ];

    // @ts-expect-error Private access
    await startupManager.startAdoptedCharts(refs);

    expect(runStep).toHaveBeenCalledTimes(refs.length);
  });

  it('still calls runStep when skipRunningActionsOnRehydrate=false (unchanged behavior)', async () => {
    const persistence = await connectTestPersistence();
    const [xJog, startupManager] = mockXJogWithStartupManager(persistence);

    xJog.options.startup.skipRunningActionsOnRehydrate = false;

    const runStep = jest.fn().mockResolvedValue(undefined);
    (xJog as unknown as { getChart: jest.Mock }).getChart = jest
      .fn()
      .mockResolvedValue({ runStep });

    // @ts-expect-error Private access
    await startupManager.startAdoptedCharts([
      { machineId: 'm', chartId: 'c1' },
    ]);

    expect(runStep).toHaveBeenCalledTimes(1);
  });
});

describe('XJogStartupManager.startAdoptedCharts: per-chart error isolation', () => {
  it('continues adopting remaining charts when getChart throws on one', async () => {
    const persistence = await connectTestPersistence();
    const [xJog, startupManager] = mockXJogWithStartupManager(persistence);

    const runStep = jest.fn().mockResolvedValue(undefined);
    const goodChart = { runStep };

    (xJog as unknown as { getChart: jest.Mock }).getChart = jest
      .fn()
      .mockImplementation(async (ref: { chartId: string }) => {
        if (ref.chartId === 'bad') {
          throw new Error(
            "Child state 'number selection' does not exist on 'mbb subscription config'",
          );
        }
        return goodChart;
      });

    // @ts-expect-error Private access
    await startupManager.startAdoptedCharts([
      { machineId: 'm', chartId: 'good-1' },
      { machineId: 'm', chartId: 'bad' },
      { machineId: 'm', chartId: 'good-2' },
    ]);

    expect(runStep).toHaveBeenCalledTimes(2);
  });

  it('continues adopting remaining charts when runStep throws on one', async () => {
    const persistence = await connectTestPersistence();
    const [xJog, startupManager] = mockXJogWithStartupManager(persistence);

    const healthyRunStep = jest.fn().mockResolvedValue(undefined);
    const poisonedRunStep = jest
      .fn()
      .mockRejectedValue(new Error('runStep exploded'));

    (xJog as unknown as { getChart: jest.Mock }).getChart = jest
      .fn()
      .mockImplementation(async (ref: { chartId: string }) => ({
        runStep: ref.chartId === 'bad' ? poisonedRunStep : healthyRunStep,
      }));

    // @ts-expect-error Private access
    await startupManager.startAdoptedCharts([
      { machineId: 'm', chartId: 'good-1' },
      { machineId: 'm', chartId: 'bad' },
      { machineId: 'm', chartId: 'good-2' },
    ]);

    expect(healthyRunStep).toHaveBeenCalledTimes(2);
    expect(poisonedRunStep).toHaveBeenCalledTimes(1);
  });

  it('logs an error for each chart that fails to adopt', async () => {
    const persistence = await connectTestPersistence();
    const [xJog, startupManager] = mockXJogWithStartupManager(persistence);

    const errorSpy = jest.fn();
    (xJog as unknown as { error: jest.Mock }).error = errorSpy;

    (xJog as unknown as { getChart: jest.Mock }).getChart = jest
      .fn()
      .mockRejectedValue(new Error('resolveState failed'));

    // @ts-expect-error Private access
    await startupManager.startAdoptedCharts([
      { machineId: 'm', chartId: 'bad' },
    ]);

    const errorCall = errorSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as Record<string, unknown>).in === 'startAdoptedCharts',
    );
    expect(errorCall).toBeDefined();
    expect((errorCall![0] as Record<string, unknown>).ref).toEqual({
      machineId: 'm',
      chartId: 'bad',
    });
  });
});
