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
