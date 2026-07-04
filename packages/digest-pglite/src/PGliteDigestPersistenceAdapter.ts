import path from 'node:path';
import { PGlite, type PGliteOptions } from '@electric-sql/pglite';
import {
  type ChartReferenceWithTimestamp,
  type DigestEntries,
  type DigestEntry,
  DigestPersistenceAdapter,
  type DigestQuery,
  filterQuery,
} from '@telia-oss/xjog-digest-persistence';
import {
  type ChartReference,
  createPositionalParameters,
} from '@telia-oss/xjog-util';
import migrationRunner from 'node-pg-migrate';

import type { PGliteDigestRow } from './PGliteDigestRow';

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
      // Do not close the pool here, it will be closed by the adapter
    }

    return adapter;
  }

  public async disconnect(): Promise<void> {
    await (await this.stopObservingNewDigestEntries)?.();
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
        '  value = $4, timestamp = transaction_timestamp() ',
      [ref.machineId, ref.chartId, key, value],
    );

    return result.affectedRows ?? 0;
  }

  protected async emitDigestEntryNotification(
    ref: ChartReference,
  ): Promise<void> {
    const payload = JSON.stringify(ref);

    await this.pool.query("SELECT pg_notify('new_digest_entry', $1::text)", [
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
    '"machineId", "chartId", "key", "value" ';

  public async readDigest(
    ref: ChartReference,
    key: string,
  ): Promise<DigestEntry | null> {
    const result = await this.pool.query<PGliteDigestRow>(
      'SELECT ' +
        this.digestEntrySqlSelectFields +
        'FROM "digests" ' +
        'WHERE "machineId" = $1 AND "chartId" = $2 AND "key" = $3 ',
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
      digestEntries[row.key] =
        PGliteDigestPersistenceAdapter.parseSqlDigestRow(row);
    }

    return digestEntries;
  }

  public async queryDigests(
    digestQuery?: DigestQuery,
  ): Promise<ChartReferenceWithTimestamp[]> {
    const [filterQueryString, filterBindings] = filterQuery(digestQuery?.query);

    // PGlite takes positional parameters only, so placeholders are numbered
    // in the order their conditions are appended, and the named `:binding`
    // tokens produced by `filterQuery` are substituted the same way.
    const { params, nextParam } = createPositionalParameters();

    let sql =
      'SELECT DISTINCT "machineId", "chartId", ' +
      '  MAX(extract(epoch from "timestamp") * 1000) as "timestamp" ' +
      'FROM "digests" WHERE TRUE ';

    if (digestQuery?.machineId !== undefined) {
      sql += `  AND "machineId" = ${nextParam(digestQuery.machineId)} `;
    }

    if (digestQuery?.chartId !== undefined) {
      sql += `  AND "chartId" = ${nextParam(digestQuery.chartId)} `;
    }

    if (filterQueryString) {
      // Match `:name` but not the `::type` casts also present in the SQL
      const positionalFilterQuery = filterQueryString.replace(
        /(^|[^:]):([A-Za-z0-9_]+)/g,
        (_match, precedingChar, bindingName) =>
          `${precedingChar}${nextParam(filterBindings[bindingName])}`,
      );
      sql += `AND (${positionalFilterQuery}) `;
    }

    sql +=
      'GROUP BY "machineId", "chartId" ' +
      'ORDER BY "timestamp" ' +
      (digestQuery?.order ?? 'ASC');

    if (digestQuery?.offset !== undefined) {
      sql += `  OFFSET ${nextParam(digestQuery.offset)} `;
    }

    if (digestQuery?.limit !== undefined) {
      sql += `  LIMIT ${nextParam(digestQuery.limit)} `;
    }

    const result = await this.pool.query<ChartReferenceWithTimestamp>(
      sql,
      params,
    );

    return result.rows;
  }

  private async startObservingNewDigestEntries(): Promise<() => Promise<void>> {
    const channel = 'new_digest_entry';

    this.pool.listen(channel, (payload: string) => {
      this.newDigestEntriesSubject.next(JSON.parse(payload) as ChartReference);
    });

    return async () => {
      await this.pool.unlisten(channel);
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
