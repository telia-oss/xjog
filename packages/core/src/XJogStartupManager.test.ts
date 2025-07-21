import { PGlitePersistenceAdapter } from '@samihult/xjog-core-pglite';
import { PersistenceAdapter } from '@samihult/xjog-core-persistence';

import { XJog } from './XJog';
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
    // @ts-ignore Private access
    jest.spyOn(startupManager, 'startAdoptionGracePeriod');
    // @ts-ignore Private access
    jest.spyOn(startupManager, 'adoptCharts');

    await startupManager.start();

    expect(persistence.overthrowOtherInstances).toHaveBeenCalled();
    // @ts-ignore Private access
    expect(startupManager.startAdoptionGracePeriod).toHaveBeenCalled();
    // @ts-ignore Private access
    expect(startupManager.adoptCharts).toHaveBeenCalled();
  });
});
