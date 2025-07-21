import { ChartReference } from '@samihult/xjog-util';
import { XJog } from './XJog';

type Rule = {
  eventName: string;
  action: 'block' | 'fail';
};

export class XJogSimulator {
  private rules: Rule[] = [];

  constructor(private readonly xJog: XJog) {}

  public addRule(rule: Rule) {
    this.rules.push(rule);
  }

  public removeRule(rule: Rule) {
    this.rules.splice(this.rules.indexOf(rule), 1);
  }

  public matchesRule(event: any): boolean {
    this.xJog.trace(
      { in: 'matchesRule', event },
      'Checking if event matches rule',
    );

    if (this.rules.length === 0) {
      return false;
    }

    return this.rules.some((rule) => rule.eventName === event.name);
  }
}
