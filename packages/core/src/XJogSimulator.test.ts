import { XJog } from './XJog';
import { XJogSimulator } from './XJogSimulator';

describe('XJogSimulator', () => {
  it('should match rules', () => {
    const simulator = new XJogSimulator({} as unknown as XJog);

    expect(simulator.matchesRule({ name: 'test' })).toBe(false);

    simulator.addRule({
      eventName: 'test',
      action: 'block',
    });

    expect(simulator.matchesRule({ name: 'test' })).toBe(false);
  });
});
