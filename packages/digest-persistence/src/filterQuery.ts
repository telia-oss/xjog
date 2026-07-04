import type { Expression } from './DigestQuery';

/**
 * Build a parameterized SQL fragment (and its bindings) matching a digest
 * filter `Expression`. Shared by the pg and pglite digest persistence
 * adapters so the filter-building logic only lives in one place.
 *
 * The recursion `prefix` already uniquely identifies this node, so the
 * binding name needs only the operator to stay unique. The digest key is
 * carried as a bound *value* (see addBindings), never interpolated into the
 * name — embedding it here produced names with hyphens/dots/digits that
 * downstream `:name` substitution (pg-bind, or the `:name` -> `$n` rewrite
 * used by pglite) truncates, mis-binding the query.
 */
export function filterQuery(
  expression?: Expression,
  prefix = 'q',
): [string, { [key: string]: string | number }] {
  if (!expression) {
    return ['', {}];
  }

  let queryString = '';
  const bindings: Record<string, string | number> = {};

  const createBindingKey = (op: 'eq' | 're' | 'lt' | 'lte' | 'gt' | 'gte') =>
    `${prefix}_${op}`;

  const keyMatchSql = (key: string, bindingKey: string): string =>
    key ? `AND "candidate"."key" = :key_${bindingKey} ` : '';

  const addBindings = (
    bindingKey: string,
    key: string,
    pattern: string | number,
  ) => {
    bindings[`key_${bindingKey}`] = key;
    bindings[`value_${bindingKey}`] = pattern;
  };

  const matchingSql = (conditionSql: string) =>
    'EXISTS ' +
    '(SELECT 1 FROM "digests" AS "candidate" ' +
    'WHERE "candidate"."machineId" = "digests"."machineId" ' +
    'AND "candidate"."chartId" = "digests"."chartId" ' +
    conditionSql +
    ')';

  switch (expression.op) {
    case 'eq': {
      const bindingKey = createBindingKey('eq');
      addBindings(bindingKey, expression.left, expression.right);
      queryString += matchingSql(
        keyMatchSql(expression.left, bindingKey) +
          `AND "candidate"."value" = :value_${bindingKey} `,
      );
      break;
    }

    case 'matches': {
      const bindingKey = createBindingKey('re');
      addBindings(bindingKey, expression.left, expression.right);
      queryString += matchingSql(
        keyMatchSql(expression.left, bindingKey) +
          `AND "candidate"."value" ~ :value_${bindingKey} `,
      );
      break;
    }

    // Numeric inequality

    case '<': {
      const bindingKey = createBindingKey('lt');
      addBindings(bindingKey, expression.left, expression.right);
      queryString += matchingSql(
        keyMatchSql(expression.left, bindingKey) +
          `AND "candidate"."value"::decimal < :value_${bindingKey}::decimal `,
      );
      break;
    }

    case '>': {
      const bindingKey = createBindingKey('gt');
      addBindings(bindingKey, expression.left, expression.right);
      queryString += matchingSql(
        keyMatchSql(expression.left, bindingKey) +
          `AND "candidate"."value"::decimal > :value_${bindingKey}::decimal `,
      );
      break;
    }

    case '<=': {
      const bindingKey = createBindingKey('lte');
      addBindings(bindingKey, expression.left, expression.right);
      queryString += matchingSql(
        keyMatchSql(expression.left, bindingKey) +
          `AND "candidate"."value"::decimal <= :value_${bindingKey}::decimal `,
      );
      break;
    }

    case '>=': {
      const bindingKey = createBindingKey('gte');
      addBindings(bindingKey, expression.left, expression.right);
      queryString += matchingSql(
        keyMatchSql(expression.left, bindingKey) +
          `AND "candidate"."value"::decimal >= :value_${bindingKey}::decimal `,
      );
      break;
    }

    // Timestamps

    case 'created before': {
      const bindingKey = `${prefix}_crbef`;
      bindings[`value_${bindingKey}`] = expression.dateTime.valueOf();
      queryString +=
        'NOT ' +
        matchingSql(
          `AND "candidate"."created" > to_timestamp(:value_${bindingKey}::decimal / 1000) `,
        );
      break;
    }

    case 'updated before': {
      const bindingKey = `${prefix}_udbef`;
      bindings[`value_${bindingKey}`] = expression.dateTime.valueOf();
      queryString +=
        'NOT ' +
        matchingSql(
          `AND "candidate"."timestamp" > to_timestamp(:value_${bindingKey}::decimal / 1000) `,
        );
      break;
    }

    case 'created after': {
      const bindingKey = `${prefix}_craft`;
      bindings[`value_${bindingKey}`] = expression.dateTime.valueOf();
      queryString +=
        'NOT ' +
        matchingSql(
          `AND "candidate"."created" < to_timestamp(:value_${bindingKey}::decimal / 1000) `,
        );
      break;
    }

    case 'updated after': {
      const bindingKey = `${prefix}_udaft`;
      bindings[`value_${bindingKey}`] = expression.dateTime.valueOf();
      queryString +=
        'NOT ' +
        matchingSql(
          `AND "candidate"."timestamp" < to_timestamp(:value_${bindingKey}::decimal / 1000) `,
        );
      break;
    }

    // Combinators

    case 'not': {
      const [subQueryString, subQueryBindings] = filterQuery(
        expression.operand,
        `${prefix}_not`,
      );
      queryString += `NOT (${subQueryString}) `;
      Object.assign(bindings, subQueryBindings);
      break;
    }

    case 'and': {
      const [leftQueryString, leftQueryBindings] = filterQuery(
        expression.left,
        `${prefix}_and_lt`,
      );
      const [rightQueryString, rightQueryBindings] = filterQuery(
        expression.right,
        `${prefix}_and_rt`,
      );
      queryString += `${leftQueryString} AND ${rightQueryString} `;
      Object.assign(bindings, leftQueryBindings);
      Object.assign(bindings, rightQueryBindings);
      break;
    }

    case 'or': {
      const [leftQueryString, leftQueryBindings] = filterQuery(
        expression.left,
        `${prefix}_or_lt`,
      );
      const [rightQueryString, rightQueryBindings] = filterQuery(
        expression.right,
        `${prefix}_or_rt`,
      );
      queryString += `${leftQueryString} OR ${rightQueryString} `;
      Object.assign(bindings, leftQueryBindings);
      Object.assign(bindings, rightQueryBindings);
      break;
    }
  }

  return [`${queryString}`, bindings];
}
