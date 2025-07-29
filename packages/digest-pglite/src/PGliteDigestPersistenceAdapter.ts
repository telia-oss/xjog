import path from 'path';
import { ChartReference } from '@samihult/xjog-util';
import { PGlite, PGliteOptions } from '@electric-sql/pglite';
import migrationRunner from 'node-pg-migrate';
import createSubscriber from 'pg-listen';

import {
  DigestPersistenceAdapter,
  DigestEntry,
  DigestEntries,
  DigestQuery,
  Expression,
  ChartReferenceWithTimestamp,
} from '@samihult/xjog-digest-persistence';

import { PGliteDigestRow } from './PGliteDigestRow';

/**
 * Use the static method `connect` to instantiate.
 * @hideconstructor
 */
export class PGliteDigestPersistenceAdapter extends DigestPersistenceAdapter {
  public readonly component = 'digest/persistence';
  public readonly type = 'pglite';

  private readonly stopObservingNewDigestEntries: Promise<() => Promise<void>>;

  public constructor(
    private readonly listenerConfig: PGliteOptions,
    private readonly pool: PGlite,
  ) {
    super();

    this.stopObservingNewDigestEntries = this.startObservingNewDigestEntries();
  }

  /**
   * Create a connection to a [PostgreSql](https://www.postgresql.org/) database
   * and resolve to a JournalPersistenceAdapter that can be passed to the XJog
   * constructor.
   */
  static async connect(
    poolConfiguration: PGliteOptions = {},
  ): Promise<PGliteDigestPersistenceAdapter> {
    const pool = await PGlite.create(poolConfiguration);
    const adapter = new PGliteDigestPersistenceAdapter(poolConfiguration, pool);

    try {
      await migrationRunner({
        dbClient: pool as any,
        migrationsTable: 'migrations_digest',
        dir: path.join(__dirname, './migrations'),
        direction: 'up',
        singleTransaction: true,
        log: (message) => adapter.trace({ in: 'connect', message }),
        // https://github.com/salsita/node-pg-migrate/issues/821
        checkOrder: false,
        noLock: false,
      });
    } finally {
      await pool.close();
    }

    return adapter;
  }

  public async disconnect(): Promise<void> {
    await (
      await this.stopObservingNewDigestEntries
    )?.();
    await this.pool.close();
  }

  protected async upsertDigest(
    ref: ChartReference,
    key: string,
    value: string,
  ): Promise<number> {
    const result = await this.pool.query(
      'INSERT INTO "digests" ' +
        '( ' +
        '  "machineId", "chartId", "key", "value" ' +
        ') VALUES ( ' +
        '  $1, $2, $3, $4' +
        ') ON CONFLICT ( ' +
        '  "machineId", "chartId", "key"' +
        ') DO UPDATE SET ' +
        '  value = :value, timestamp = transaction_timestamp() ',
      [ref.machineId, ref.chartId, key, value],
    );

    return result.affectedRows ?? 0;
  }

  protected async emitDigestEntryNotification(
    ref: ChartReference,
  ): Promise<void> {
    const payload = JSON.stringify(ref);

    await this.pool.query("SELECT pg_notify('new-digest-entry', $1::text)", [
      payload,
    ]);
  }

  public async deleteDigest(ref: ChartReference, key: string): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM "digests" ' +
        'WHERE "machineId" = $1 AND "chartId" = $2 AND "key" = $3 ',
      [ref.machineId, ref.chartId, key],
    );

    return result.affectedRows ?? 0;
  }

  public async deleteByChart(ref: ChartReference): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM "digests" ' + 'WHERE "machineId" = $1 AND "chartId" = $2 ',
      [ref.machineId, ref.chartId],
    );

    return result.affectedRows ?? 0;
  }

  /** Corresponds to {@link PostgresDigestRow} */
  private readonly digestEntrySqlSelectFields =
    'extract(epoch from "created") * 1000 AS "created", ' +
    'extract(epoch from "timestamp") * 1000 AS "timestamp", ' +
    '"machineId", "chartId", "key, "value" ';

  public async readDigest(
    ref: ChartReference,
    key: string,
  ): Promise<DigestEntry | null> {
    const result = await this.pool.query<PGliteDigestRow>(
      'SELECT ' +
        this.digestEntrySqlSelectFields +
        'FROM "digests" ' +
        'WHERE "machineId" = $1 AND "chartId" = $2 AND key = $3 ',
      [ref.machineId, ref.chartId, key],
    );

    if (!result.rows.length) {
      return null;
    }

    return PGliteDigestPersistenceAdapter.parseSqlDigestRow(result.rows[0]);
  }

  public async readByChart(ref: ChartReference): Promise<DigestEntries> {
    const result = await this.pool.query<PGliteDigestRow>(
      'SELECT ' +
        this.digestEntrySqlSelectFields +
        'FROM "digests" ' +
        'WHERE "machineId" = $1 AND "chartId" = $2 ',
      [ref.machineId, ref.chartId],
    );

    const digestEntries: DigestEntries = {};

    for (const row of result.rows) {
      digestEntries[row.machineId] =
        PGliteDigestPersistenceAdapter.parseSqlDigestRow(row);
    }

    return digestEntries;
  }

  public async queryDigests(
    digestQuery?: DigestQuery,
  ): Promise<ChartReferenceWithTimestamp[]> {
    const [filterQuery, filterBindings] =
      PGliteDigestPersistenceAdapter.filterQuery(digestQuery?.query);

    const result = await this.pool.query<ChartReferenceWithTimestamp>(
      'SELECT DISTINCT "machineId", "chartId", ' +
        '  MAX(extract(epoch from "timestamp") * 1000) as "timestamp" ' +
        'FROM "digests" WHERE TRUE ' +
        (digestQuery?.machineId !== undefined
          ? '  AND "machineId" = $1 '
          : '') +
        (digestQuery?.chartId !== undefined ? '  AND "chartId" = $2 ' : '') +
        (filterQuery ? `AND (${filterQuery}) ` : '') +
        'GROUP BY "machineId", "chartId" ' +
        'ORDER BY "timestamp" ' +
        (digestQuery?.order ?? 'ASC') +
        (digestQuery?.offset !== undefined ? '  OFFSET $3 ' : '') +
        (digestQuery?.limit !== undefined ? '  LIMIT $4 ' : ''),
      [
        digestQuery?.machineId,
        digestQuery?.chartId,
        digestQuery?.offset,
        digestQuery?.limit,
        // ...filterBindings,
        // TODO --^
      ],
    );

    return result.rows;
  }

  static filterQuery(
    expression?: Expression,
    prefix = 'q',
  ): [string, { [key: string]: string | number }] {
    if (!expression) {
      return ['', {}];
    }

    let queryString = '';
    const bindings: Record<string, string | number> = {};

    const createBindingKey = (
      op: 'eq' | 're' | 'lt' | 'lte' | 'gt' | 'gte',
      key: string,
    ) => `${prefix}_${op}_${key}`;

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
        const bindingKey = createBindingKey('eq', expression.left);
        addBindings(bindingKey, expression.left, expression.right);
        queryString += matchingSql(
          keyMatchSql(expression.left, bindingKey) +
            `AND "candidate"."value" = :value_${bindingKey} `,
        );
        break;
      }

      case 'matches': {
        const bindingKey = createBindingKey('re', expression.left);
        addBindings(bindingKey, expression.left, expression.right);
        queryString += matchingSql(
          keyMatchSql(expression.left, bindingKey) +
            `AND "candidate"."value" ~ :value_${bindingKey} `,
        );
        break;
      }

      // Numeric inequality

      case '<': {
        const bindingKey = createBindingKey('lt', expression.left);
        addBindings(bindingKey, expression.left, expression.right);
        queryString += matchingSql(
          keyMatchSql(expression.left, bindingKey) +
            `AND "candidate"."value"::decimal < :value_${bindingKey}::decimal `,
        );
        break;
      }

      case '>': {
        const bindingKey = createBindingKey('gt', expression.left);
        addBindings(bindingKey, expression.left, expression.right);
        queryString += matchingSql(
          keyMatchSql(expression.left, bindingKey) +
            `AND "candidate"."value"::decimal > :value_${bindingKey}::decimal `,
        );
        break;
      }

      case '<=': {
        const bindingKey = createBindingKey('lte', expression.left);
        addBindings(bindingKey, expression.left, expression.right);
        queryString += matchingSql(
          keyMatchSql(expression.left, bindingKey) +
            `AND "candidate"."value"::decimal <= :value_${bindingKey}::decimal `,
        );
        break;
      }

      case '>=': {
        const bindingKey = createBindingKey('gte', expression.left);
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
        const bindingKey = `${prefix}_crbef`;
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
        const [subQueryString, subQueryBindings] =
          PGliteDigestPersistenceAdapter.filterQuery(
            expression.operand,
            prefix + '_not',
          );
        queryString += `NOT (${subQueryString}) `;
        Object.assign(bindings, subQueryBindings);
        break;
      }

      case 'and': {
        const [leftQueryString, leftQueryBindings] =
          PGliteDigestPersistenceAdapter.filterQuery(
            expression.left,
            prefix + '_and_lt',
          );
        const [rightQueryString, rightQueryBindings] =
          PGliteDigestPersistenceAdapter.filterQuery(
            expression.right,
            prefix + '_and_rt',
          );
        queryString += `${leftQueryString} AND ${rightQueryString} `;
        Object.assign(bindings, leftQueryBindings);
        Object.assign(bindings, rightQueryBindings);
        break;
      }

      case 'or': {
        const [leftQueryString, leftQueryBindings] =
          PGliteDigestPersistenceAdapter.filterQuery(
            expression.left,
            prefix + '_or_lt',
          );
        const [rightQueryString, rightQueryBindings] =
          PGliteDigestPersistenceAdapter.filterQuery(
            expression.right,
            prefix + '_or_rt',
          );
        queryString += `${leftQueryString} OR ${rightQueryString} `;
        Object.assign(bindings, leftQueryBindings);
        Object.assign(bindings, rightQueryBindings);
        break;
      }
    }

    return [`${queryString}`, bindings];
  }

  private async startObservingNewDigestEntries(): Promise<() => Promise<void>> {
    const channel = 'new-digest-entry';

    // TODO: Implement
    return () => Promise.resolve();

    const digestSubscriber = createSubscriber(this.listenerConfig);

    // Received a notification of a new journal entry
    digestSubscriber.notifications.on(channel, async (ref: ChartReference) => {
      this.newDigestEntriesSubject.next(ref);
    });

    digestSubscriber.events.on('error', (error) => {
      this.newDigestEntriesSubject.error(error);
    });

    digestSubscriber.connect().then(() => digestSubscriber.listenTo(channel));

    return async () => {
      await digestSubscriber.close();
    };
  }

  static parseSqlDigestRow(row: PGliteDigestRow): DigestEntry {
    return {
      created: Number(row.created),
      timestamp: Number(row.timestamp),

      ref: {
        machineId: row.machineId,
        chartId: row.chartId,
      },

      key: row.key,
      value: row.value,
    };
  }
}
