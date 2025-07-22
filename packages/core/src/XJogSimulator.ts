import { XJog } from './XJog';

export type SimulatorRule = {
  eventName: string;
  action: 'block' | 'fail' | 'delay';
  value?: string;
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
 *
 * // Add a rule to block the event 'foo'
 * // Other actions are 'fail' and 'delay'
 * simulator.addRule({ eventName: 'foo', action: 'block' });
 *
 * // Send events
 * await xJog.sendEvent('foo'); // Event is blocked
 * await xJog.sendEvent('bar'); // Event is not blocked
 *
 * // Remove the rule
 * simulator.removeRule({ eventName: 'foo' });
 * await xJog.sendEvent('foo'); // Event is no longer blocked
 * ```
 */
export class XJogSimulator {
  private rules: SimulatorRule[] = [];

  constructor(private readonly xJog: XJog) {}

  public isEnabled(): boolean {
    return this.rules.length > 0;
  }

  public addRule(rule: SimulatorRule) {
    this.rules.push(rule);
  }

  public removeRule(rule: Partial<SimulatorRule>) {
    const matchingRule = this.matchesRule(rule);
    if (matchingRule) {
      this.rules.splice(this.rules.indexOf(matchingRule), 1);
    }
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
