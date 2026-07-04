import {
  type ChartReference,
  createPositionalParameters,
} from '@telia-oss/xjog-util';
import type { DigestEntries } from './DigestEntries';
import type { DigestEntry } from './DigestEntry';
import type { ChartReferenceWithTimestamp } from './DigestPersistenceAdapter';
import { DigestPersistenceAdapter } from './DigestPersistenceAdapter';
import type { DigestQuery } from './DigestQuery';
import { filterQuery } from './filterQuery';
import type { PostgresDigestRow } from './PostgresDigestRow';
import type { PostgresQueryRunner } from './PostgresQueryRunner';

/**
 * Shared implementation of the pure-SQL digest persistence methods, written
 * once against `$N` positional placeholders so it can run unmodified on any
 * Postgres-compatible driver. Concrete adapters (`digest-pg`, `digest-pglite`)
 * only need to supply a {@link PostgresQueryRunner}-shaped `runQuery` hook
 * that executes SQL text plus a params array and normalizes the driver's
 * result shape.
 *
 * @hideconstructor
 */
export abstract class AbstractPostgresDigestPersistenceAdapter extends DigestPersistenceAdapter {
  /**
   * Run a parameterized SQL statement against the underlying driver and
   * return its rows and affected row count in a normalized shape. Matches
   * the shape of {@link PostgresQueryRunner.query}.
   */
  protected abstract runQuery<T>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;

  /**
   * The `LISTEN`/`NOTIFY` channel name used to announce new digest entries.
   * The two drivers historically used slightly different literal channel
   * names (pg: `new-digest-entry`, pglite: `new_digest_entry`); each
   * concrete adapter keeps its own subscriber wired to the same name so
   * behavior is unchanged.
   */
  protected abstract readonly newDigestEntryChannel: string;

  protected async upsertDigest(
    ref: ChartReference,
    key: string,
    value: string,
  ): Promise<number> {
    const result = await this.runQuery(
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

    return result.rowCount;
  }

  protected async emitDigestEntryNotification(
    ref: ChartReference,
  ): Promise<void> {
    const payload = JSON.stringify(ref);

    await this.runQuery(
      `SELECT pg_notify('${this.newDigestEntryChannel}', $1::text)`,
      [payload],
    );
  }

  public async deleteDigest(ref: ChartReference, key: string): Promise<number> {
    const result = await this.runQuery(
      'DELETE FROM "digests" ' +
        'WHERE "machineId" = $1 AND "chartId" = $2 AND "key" = $3 ',
      [ref.machineId, ref.chartId, key],
    );

    return result.rowCount;
  }

  public async deleteByChart(ref: ChartReference): Promise<number> {
    const result = await this.runQuery(
      'DELETE FROM "digests" ' + 'WHERE "machineId" = $1 AND "chartId" = $2 ',
      [ref.machineId, ref.chartId],
    );

    return result.rowCount;
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
    const result = await this.runQuery<PostgresDigestRow>(
      'SELECT ' +
        this.digestEntrySqlSelectFields +
        'FROM "digests" ' +
        'WHERE "machineId" = $1 AND "chartId" = $2 AND "key" = $3 ',
      [ref.machineId, ref.chartId, key],
    );

    if (!result.rows.length) {
      return null;
    }

    return AbstractPostgresDigestPersistenceAdapter.parseSqlDigestRow(
      result.rows[0],
    );
  }

  public async readByChart(ref: ChartReference): Promise<DigestEntries> {
    const result = await this.runQuery<PostgresDigestRow>(
      'SELECT ' +
        this.digestEntrySqlSelectFields +
        'FROM "digests" ' +
        'WHERE "machineId" = $1 AND "chartId" = $2 ',
      [ref.machineId, ref.chartId],
    );

    const digestEntries: DigestEntries = {};

    for (const row of result.rows) {
      digestEntries[row.key] =
        AbstractPostgresDigestPersistenceAdapter.parseSqlDigestRow(row);
    }

    return digestEntries;
  }

  public async queryDigests(
    digestQuery?: DigestQuery,
  ): Promise<ChartReferenceWithTimestamp[]> {
    const [filterQueryString, filterBindings] = filterQuery(digestQuery?.query);

    // The driver takes positional parameters only, so placeholders are
    // numbered in the order their conditions are appended, and the named
    // `:binding` tokens produced by `filterQuery` are substituted the same
    // way.
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

    const result = await this.runQuery<ChartReferenceWithTimestamp>(
      sql,
      params,
    );

    return result.rows;
  }

  static parseSqlDigestRow(row: PostgresDigestRow): DigestEntry {
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
