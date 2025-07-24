import { XJog } from './XJog';

export type SimulatorAction = 'skip' | 'fail' | 'delay';

export type SimulatorRule = {
  event: string;
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
 * // Add a rule to skip the event 'foo'
 * // Other actions are 'fail' and 'delay'
 * // You can also set a percentage (0-100) to the rule to control the likelihood of the rule being matched
 * simulator.addRule({ eventName: 'foo', action: 'skip', percentage: 50 });
 *
 * // Send events
 * await xJog.sendEvent('foo'); // Event is skipped 50% of the time
 * await xJog.sendEvent('bar'); // Event is not skipped
 *
 * // Remove the rule
 * simulator.removeRule({ eventName: 'foo' });
 * await xJog.sendEvent('foo'); // Event is no longer skipped
 * ```
 */
export class XJogSimulator {
  private rules: SimulatorRule[] = [];

  constructor(private readonly xJog: XJog) {}

  public isEnabled(): boolean {
    return this.rules.length > 0;
  }

  public addRule(rule: SimulatorRule): void {
    this.rules.push(rule);
  }

  public addRules(rules: SimulatorRule[]): void {
    this.rules.push(...rules);
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

  public matchesRule(
    ruleCandidate: Partial<SimulatorRule>,
  ): SimulatorRule | null {
    const matchingRule = this.rules.find((rule) => {
      return Object.keys(ruleCandidate).every((matcherKey) => {
        const key = matcherKey as keyof SimulatorRule;

        // Support wildcards in the event name
        if (key === 'event' && rule.event?.endsWith('*')) {
          return ruleCandidate[key]?.startsWith(rule.event.replace('*', ''));
        }

        return rule[key] === ruleCandidate[key];
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
      this.xJog.trace(
        { event: ruleCandidate.event, rule: matchingRule },
        'Simulator rule matched',
      );
      return matchingRule;
    }
    return null;
  }
}
