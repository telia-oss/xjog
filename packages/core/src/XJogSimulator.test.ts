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
    expect(simulator.matchesRule({ event: 'test' })).toBeNull();

    const testRule: SimulatorRule = {
      event: 'test',
      action: 'skip',
    };

    simulator.addRule(testRule);

    expect(simulator.matchesRule({ event: 'test' })).toEqual(testRule);
    expect(simulator.matchesRule({ event: 'test', action: 'skip' })).toEqual(
      testRule,
    );
    expect(simulator.matchesRule({ event: 'test', action: 'fail' })).toBeNull();
    expect(simulator.matchesRule({ event: 'invalid', action: 'fail' })).toBe(
      null,
    );
  });

  it('should add multiple rules', async () => {
    const testRule1: SimulatorRule = {
      event: 'test1',
      action: 'skip',
    };
    const testRule2: SimulatorRule = {
      event: 'test2',
      action: 'skip',
    };

    simulator.addRules([testRule1, testRule2]);
    expect(simulator.matchesRule({ event: 'test1' })).toEqual(testRule1);
    expect(simulator.matchesRule({ event: 'test2' })).toEqual(testRule2);
    expect(simulator.matchesRule({ event: 'test3' })).toBeNull();
  });

  it('should remove rules', async () => {
    const testRule: SimulatorRule = {
      event: 'test',
      action: 'skip',
    };

    simulator.addRule(testRule);
    expect(simulator.matchesRule(testRule)).toEqual(testRule);

    simulator.removeRule({ event: 'test' });
    expect(simulator.matchesRule(testRule)).toBeNull();
  });

  it('should remove multiple rules', async () => {
    const testRule1: SimulatorRule = {
      event: 'test1',
      action: 'skip',
    };
    const testRule2: SimulatorRule = {
      event: 'test2',
      action: 'skip',
    };

    simulator.addRule(testRule1);
    simulator.addRule(testRule2);

    expect(simulator.matchesRule({ action: 'skip' })).toEqual(testRule1);
    simulator.removeRule({ action: 'skip' });
    expect(simulator.matchesRule({ action: 'skip' })).toBeNull();
  });

  it('should remove all rules', async () => {
    const testRule: SimulatorRule = {
      event: 'test',
      action: 'skip',
    };

    simulator.addRule(testRule);
    expect(simulator.matchesRule({ event: 'test' })).toEqual(testRule);

    simulator.removeRule();
    expect(simulator.matchesRule({ event: 'test' })).toBeNull();
  });

  it('should match rules with percentage', async () => {
    // 100% chance of matching
    const matchingRule: SimulatorRule = {
      event: 'test',
      action: 'skip',
      percentage: 100,
    };
    // 0% chance of matching
    const notMatchingRule: SimulatorRule = {
      event: 'test',
      action: 'skip',
      percentage: 0,
    };

    // Remove old rule and add new one
    simulator.removeRule();
    simulator.addRule(matchingRule);
    expect(simulator.matchesRule({ event: 'test' })).toEqual(matchingRule);

    // Remove old rule and add new one
    simulator.removeRule();
    simulator.addRule(notMatchingRule);
    expect(simulator.matchesRule({ event: 'test' })).toBeNull();
  });

  it('should match with wildcard event', async () => {
    const testRule: SimulatorRule = {
      event: 'test.*',
      action: 'skip',
    };

    simulator.addRule(testRule);
    expect(simulator.matchesRule({ event: 'test.1' })).toEqual(testRule);
    expect(simulator.matchesRule({ event: 'test.2' })).toEqual(testRule);

    expect(
      simulator.matchesRule({ event: 'test.2', action: 'fail' }),
    ).toBeNull();
    expect(simulator.matchesRule({ event: 'foo.1' })).toBeNull();
  });

  it('should match all events', async () => {
    const testRule: SimulatorRule = {
      event: '*',
      action: 'skip',
    };

    simulator.addRule(testRule);
    expect(simulator.matchesRule({ event: 'test.1' })).toEqual(testRule);
    expect(simulator.matchesRule({ event: 'test.2', action: 'skip' })).toEqual(
      testRule,
    );
    expect(simulator.matchesRule({ event: 'foo.1', action: 'skip' })).toEqual(
      testRule,
    );
    expect(
      simulator.matchesRule({ event: 'foo.1', action: 'fail' }),
    ).toBeNull();
  });
});
