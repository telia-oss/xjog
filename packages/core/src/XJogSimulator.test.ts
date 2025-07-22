import { PersistenceAdapter } from '@samihult/xjog-core-persistence';
import { XJog } from './XJog';
import { SimulatorRule, XJogSimulator } from './XJogSimulator';
import { PGlitePersistenceAdapter } from '@samihult/xjog-core-pglite';

function mockXJogWithSimulator(
  persistence: PersistenceAdapter,
  trace = false,
): [XJog, XJogSimulator] {
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

  xJog.simulator = new XJogSimulator(xJog);

  return [xJog as unknown as XJog, xJog.simulator];
}

describe('XJogSimulator', () => {
  let persistence: PersistenceAdapter;
  let simulator: XJogSimulator;

  beforeEach(async () => {
    persistence = await PGlitePersistenceAdapter.connect();
    [, simulator] = mockXJogWithSimulator(persistence);
  });

  it('should match rules', async () => {
    expect(simulator.matchesRule({ eventName: 'test' })).toBeNull();

    const testRule: SimulatorRule = {
      eventName: 'test',
      action: 'block',
    };

    simulator.addRule(testRule);

    expect(simulator.matchesRule({ eventName: 'test' })).toEqual(testRule);
    expect(
      simulator.matchesRule({ eventName: 'test', action: 'block' }),
    ).toEqual(testRule);
    expect(
      simulator.matchesRule({ eventName: 'test', action: 'fail' }),
    ).toBeNull();
    expect(
      simulator.matchesRule({ eventName: 'invalid', action: 'fail' }),
    ).toBe(null);
  });

  it('should remove rules', async () => {
    const testRule: SimulatorRule = {
      eventName: 'test',
      action: 'block',
    };

    simulator.addRule(testRule);
    expect(simulator.matchesRule(testRule)).toEqual(testRule);

    simulator.removeRule({ eventName: 'test' });
    expect(simulator.matchesRule(testRule)).toBeNull();
  });
});
