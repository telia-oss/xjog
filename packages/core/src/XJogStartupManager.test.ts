import type { PersistenceAdapter } from '@samihult/xjog-core-persistence';
import { PGlitePersistenceAdapter } from '@samihult/xjog-core-pglite';

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
      },
    },
  };

  xJog.startupManager = new XJogStartupManager(xJog);

  return [xJog as unknown as XJog, xJog.startupManager];
}

describe('XJogStartupManager', () => {
  it('Is initially idle, not started and not finished', async () => {
    const persistence = await PGlitePersistenceAdapter.connect();
    const [, startupManager] = mockXJogWithStartupManager(persistence);

    expect(startupManager.started).toBe(false);
    expect(startupManager.ready).toBe(false);
  });

  it('Become ready right after the startup sequence when nothing to adopt', async () => {
    const persistence = await PGlitePersistenceAdapter.connect();
    const [, startupManager] = mockXJogWithStartupManager(persistence);

    await startupManager.start();

    expect(startupManager.started).toBe(true);
    expect(startupManager.ready).toBe(true);
  });

  it('Executes the right routines during the startup', async () => {
    const persistence = await PGlitePersistenceAdapter.connect();
    const [, startupManager] = mockXJogWithStartupManager(persistence);

    jest.spyOn(persistence, 'overthrowOtherInstances');
    // @ts-expect-error Private access
    jest.spyOn(startupManager, 'startAdoptionGracePeriod');
    // @ts-expect-error Private access
    jest.spyOn(startupManager, 'adoptCharts');

    await startupManager.start();

    expect(persistence.overthrowOtherInstances).toHaveBeenCalled();
    // @ts-expect-error Private access
    expect(startupManager.startAdoptionGracePeriod).toHaveBeenCalled();
    // @ts-expect-error Private access
    expect(startupManager.adoptCharts).toHaveBeenCalled();
  });
});

describe('XJogStartupManager: grace period timer must not reset on every cycle', () => {
  it('Does not restart the grace period timer when it is already running', async () => {
    const persistence = await PGlitePersistenceAdapter.connect();
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
    const persistence = await PGlitePersistenceAdapter.connect();
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
    const persistence = await PGlitePersistenceAdapter.connect();
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
    const persistence = await PGlitePersistenceAdapter.connect();
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
    const persistence = await PGlitePersistenceAdapter.connect();
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
    const persistence = await PGlitePersistenceAdapter.connect();
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
    const persistence = await PGlitePersistenceAdapter.connect();
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
