import { XJog } from './XJog';

export type SimulatorAction = 'block' | 'fail' | 'delay';

export type SimulatorRule = {
  eventName: string;
  action: SimulatorAction;
  value?: string;
  percentage?: number; // 0-100
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
 * // You can also set a percentage (0-100) to the rule to control the likelihood of the rule being matched
 * simulator.addRule({ eventName: 'foo', action: 'block', percentage: 50 });
 *
 * // Send events
 * await xJog.sendEvent('foo'); // Event is blocked 50% of the time
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

  public removeRule(matcher?: Partial<SimulatorRule>) {
    // If no matcher is provided, remove all rules
    if (!matcher) {
      this.rules = [];
      return;
    }

    const matchingRule = this.matchesRule(matcher);
    if (matchingRule) {
      this.rules.splice(this.rules.indexOf(matchingRule), 1);
      // Remove all rules that match the same matcher
      this.removeRule(matcher);
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

    // Take the percentage into account
    // Bigger then number means more likely the rule will be matched
    const givenPercentage = matchingRule.percentage ?? 100;
    const randomPercentage = Math.random() * 100;
    if (randomPercentage < givenPercentage) {
      return matchingRule;
    }
    return null;
  }
}
