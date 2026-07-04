import type { Expression } from './DigestQuery';
import { filterQuery } from './filterQuery';

describe('filterQuery', () => {
  it('returns an empty query and no bindings when no expression is given', () => {
    const [sql, bindings] = filterQuery(undefined);

    expect(sql).toBe('');
    expect(bindings).toEqual({});
  });

  it('builds an "eq" condition', () => {
    const expression: Expression = { op: 'eq', left: 'name', right: 'Bob' };
    const [sql, bindings] = filterQuery(expression);

    expect(sql).toContain('"candidate"."key" = :key_q_eq');
    expect(sql).toContain('"candidate"."value" = :value_q_eq');
    expect(bindings).toEqual({
      key_q_eq: 'name',
      value_q_eq: 'Bob',
    });
  });

  it('builds a "matches" condition', () => {
    const expression: Expression = {
      op: 'matches',
      left: 'birthday',
      right: '1982-\\d{2}-\\d{2}',
    };
    const [sql, bindings] = filterQuery(expression);

    expect(sql).toContain('"candidate"."key" = :key_q_re');
    expect(sql).toContain('"candidate"."value" ~ :value_q_re');
    expect(bindings).toEqual({
      key_q_re: 'birthday',
      value_q_re: '1982-\\d{2}-\\d{2}',
    });
  });

  it.each([
    ['<', 'lt', '<'],
    ['>', 'gt', '>'],
    ['<=', 'lte', '<='],
    ['>=', 'gte', '>='],
  ] as const)('builds a "%s" numeric comparison condition', (op, opAbbrev, sqlOperator) => {
    const expression: Expression = {
      op,
      left: 'itemQuantity',
      right: 99,
    };
    const [sql, bindings] = filterQuery(expression);

    expect(sql).toContain(`"candidate"."key" = :key_q_${opAbbrev}`);
    expect(sql).toContain(
      `"candidate"."value"::decimal ${sqlOperator} :value_q_${opAbbrev}::decimal`,
    );
    expect(bindings).toEqual({
      [`key_q_${opAbbrev}`]: 'itemQuantity',
      [`value_q_${opAbbrev}`]: 99,
    });
  });

  it.each([
    ['created before', 'crbef', '>'],
    ['updated before', 'udbef', '>'],
    ['created after', 'craft', '<'],
    ['updated after', 'udaft', '<'],
  ] as const)('builds a "%s" timestamp condition', (op, opAbbrev, comparison) => {
    const dateTime = new Date('2024-01-01T00:00:00.000Z');
    const expression: Expression = { op, dateTime };
    const [sql, bindings] = filterQuery(expression);

    expect(sql.startsWith('NOT ')).toBe(true);
    expect(sql).toContain(`to_timestamp(:value_q_${opAbbrev}::decimal / 1000)`);
    expect(sql).toContain(`${comparison} to_timestamp`);
    expect(bindings).toEqual({
      [`value_q_${opAbbrev}`]: dateTime.valueOf(),
    });
  });

  it('builds a "not" condition wrapping the operand', () => {
    const expression: Expression = {
      op: 'not',
      operand: { op: 'eq', left: 'name', right: 'Bob' },
    };
    const [sql, bindings] = filterQuery(expression);

    expect(sql.startsWith('NOT (')).toBe(true);
    expect(bindings).toEqual({
      key_q_not_eq: 'name',
      value_q_not_eq: 'Bob',
    });
  });

  it('builds an "and" condition combining left and right with unique bindings', () => {
    const expression: Expression = {
      op: 'and',
      left: { op: 'eq', left: 'name', right: 'Bob' },
      right: { op: '<=', left: 'itemQuantity', right: 99 },
    };
    const [sql, bindings] = filterQuery(expression);

    expect(sql).toContain(' AND ');
    expect(bindings).toEqual({
      key_q_and_lt_eq: 'name',
      value_q_and_lt_eq: 'Bob',
      key_q_and_rt_lte: 'itemQuantity',
      value_q_and_rt_lte: 99,
    });
  });

  it('builds an "or" condition combining left and right with unique bindings', () => {
    const expression: Expression = {
      op: 'or',
      left: { op: 'eq', left: 'name', right: 'Bob' },
      right: { op: 'eq', left: 'name', right: 'Alice' },
    };
    const [sql, bindings] = filterQuery(expression);

    expect(sql).toContain(' OR ');
    expect(bindings).toEqual({
      key_q_or_lt_eq: 'name',
      value_q_or_lt_eq: 'Bob',
      key_q_or_rt_eq: 'name',
      value_q_or_rt_eq: 'Alice',
    });
  });

  it('keeps binding keys unique across deeply nested combinators', () => {
    const expression: Expression = {
      op: 'and',
      left: {
        op: 'or',
        left: { op: 'eq', left: 'name', right: 'Bob' },
        right: { op: 'eq', left: 'name', right: 'Alice' },
      },
      right: {
        op: 'not',
        operand: { op: '<', left: 'itemQuantity', right: 1 },
      },
    };
    const [, bindings] = filterQuery(expression);
    const keys = Object.keys(bindings);

    expect(new Set(keys).size).toBe(keys.length);
    expect(bindings).toEqual({
      key_q_and_lt_or_lt_eq: 'name',
      value_q_and_lt_or_lt_eq: 'Bob',
      key_q_and_lt_or_rt_eq: 'name',
      value_q_and_lt_or_rt_eq: 'Alice',
      key_q_and_rt_not_lt: 'itemQuantity',
      value_q_and_rt_not_lt: 1,
    });
  });

  it('respects a custom prefix', () => {
    const expression: Expression = { op: 'eq', left: 'name', right: 'Bob' };
    const [sql, bindings] = filterQuery(expression, 'custom');

    expect(sql).toContain(':key_custom_eq');
    expect(sql).toContain(':value_custom_eq');
    expect(bindings).toEqual({
      key_custom_eq: 'name',
      value_custom_eq: 'Bob',
    });
  });
});
