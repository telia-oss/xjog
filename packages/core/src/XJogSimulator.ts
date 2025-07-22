import { XJog } from './XJog';

export type SimulatorRule = {
  eventName: string;
  action: 'block' | 'fail';
};

/**
 * XJogSimulator is a class that allows you to simulate events and errors.
 * It is used to test XJog in a controlled environment.
 *
 * @example
 * ```ts
 * const xJog = new XJog({
 *   persistence: await PGlitePersistenceAdapter.connect(),
 * });
 * const simulator = xJog.simulator;
 * simulator.addRule({ eventName: 'foo', action: 'block' });
 *
 * const result = await xJog.sendEvent('foo'); // Event is blocked
 * const result = await xJog.sendEvent('bar'); // Event is not blocked
 * ```
 */
export class XJogSimulator {
  private rules: SimulatorRule[] = [];

  constructor(private readonly xJog: XJog) {}

  public addRule(rule: SimulatorRule) {
    this.rules.push(rule);
  }

  public removeRule(rule: SimulatorRule) {
    this.rules.splice(this.rules.indexOf(rule), 1);
  }

  public matchesRule(matcher: Partial<SimulatorRule>): SimulatorRule | null {
    this.xJog.trace(
      { in: 'matchesRule', event: matcher },
      'Checking if event matches rule',
    );

    const matchingRule = this.rules.find((rule) => {
      return Object.keys(matcher).every((matcherKey) => {
        const key = matcherKey as keyof SimulatorRule;
        return rule[key] === matcher[key];
      });
    });

    if (!matchingRule) {
      return null;
    }

    return matchingRule;
  }
}
