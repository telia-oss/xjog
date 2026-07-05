import {
  type ChartReference,
  createPositionalParameters,
  decodeBytea,
} from '@telia-oss/xjog-util';
import type { FullStateEntry } from './FullStateEntry';
import type { FullStateQuery } from './FullStateQuery';
import type {
  JournalEntry,
  JournalEntryAutoFields,
  JournalEntryInsertFields,
} from './JournalEntry';
import { JournalPersistenceAdapter } from './JournalPersistenceAdapter';
import type { JournalQuery } from './JournalQuery';
import type { JournalQueryRunner } from './JournalQueryRunner';
import type { PostgresFullStateRow } from './PostgresFullStateRow';
import type { PostgresJournalRow } from './PostgresJournalRow';

/**
 * Shared implementation of the pure-SQL journal persistence methods, written
 * once against `$N` positional placeholders so it can run unmodified on any
 * Postgres-compatible driver. `journal-pg` keeps its 4-connection topology
 * (subscription / read / write / update), so this base routes each method to
 * one of three role-based query hooks rather than a single `runQuery` — each
 * concrete adapter (`journal-pg`, `journal-pglite`) wires the hooks to the
 * connection(s) it already uses for that role. `journal-pglite` has a single
 * connection and so implements all three hooks over it.
 *
 * @hideconstructor
 */
export abstract class AbstractPostgresJournalPersistenceAdapter extends JournalPersistenceAdapter {
  /** Runs writes: {@link insertEntry}, {@link updateFullState}. */
  protected abstract runWriteQuery<T>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;

  /**
   * Runs updates/deletes and the notify call:
   * {@link emitJournalEntryNotification}, {@link deleteByChart}.
   */
  protected abstract runUpdateQuery<T>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;

  /**
   * Runs reads: {@link readEntry}, {@link queryEntries},
   * {@link readFullState}, {@link queryFullStates}, {@link getCurrentTime}.
   */
  protected abstract runReadQuery<T>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;

  /**
   * The `LISTEN`/`NOTIFY` channel name used to announce new journal entries.
   * The two drivers historically used slightly different literal channel
   * names (pg: `new-journal-entry`, pglite: `new_journal_entry`); each
   * concrete adapter keeps its own subscriber wired to the same name so
   * behavior is unchanged.
   */
  protected abstract readonly newJournalEntryChannel: string;

  protected async insertEntry(
    entry: JournalEntryInsertFields,
  ): Promise<JournalEntryAutoFields> {
    const result = await this.runWriteQuery<{ id: number; timestamp: number }>(
      'INSERT INTO "journalEntries" ' +
        '(' +
        '  "machineId", "chartId", "event",  ' +
        '  "state", "context", "stateDelta", "contextDelta", ' +
        '  "actions" ' +
        ') ' +
        'VALUES (' +
        '  $1, $2, $3, NULL, NULL, ' +
        '  $4, $5, $6 ' +
        ') ' +
        'RETURNING ' +
        '  "id", extract(epoch from "timestamp") * 1000 as "timestamp" ',
      [
        entry.ref.machineId,
        entry.ref.chartId,
        entry.event ? Buffer.from(JSON.stringify(entry.event)) : null,
        Buffer.from(JSON.stringify(entry.stateDelta)),
        Buffer.from(JSON.stringify(entry.contextDelta)),
        entry.actions ? Buffer.from(JSON.stringify(entry.actions)) : null,
      ],
    );

    if (!result.rows.length) {
      throw new Error('Failed to write journal entry');
    }

    return {
      id: result.rows[0].id,
      timestamp: Number(result.rows[0].timestamp),
    };
  }

  protected async updateFullState(entry: FullStateEntry): Promise<void> {
    const result = await this.runWriteQuery(
      'INSERT INTO "fullJournalStates" ' +
        '( ' +
        '  "id", "created", "timestamp", ' +
        '  "ownerId", "machineId", "chartId", ' +
        '  "parentMachineId", "parentChartId", ' +
        '  "event", "state", "context", ' +
        '  "actions" ' +
        ') ' +
        'VALUES (' +
        '  $1, to_timestamp($2::decimal / 1000), ' +
        '  to_timestamp($2::decimal / 1000), ' +
        '  $3, $4, $5, ' +
        '  $6, $7, ' +
        '  $8, $9, $10, $11 ' +
        ') ON CONFLICT (' +
        '  "machineId", "chartId" ' +
        ') DO UPDATE SET ' +
        '  "id" = $1, "timestamp" = to_timestamp($2::decimal / 1000), ' +
        '  "event" = $8, "state" = $9, "context" = $10, ' +
        '  "actions" = $11 ' +
        'WHERE "fullJournalStates"."id" < $1 ',
      [
        entry.id, // $1
        entry.timestamp, // $2
        entry.ownerId, // $3
        entry.ref.machineId, // $4
        entry.ref.chartId, // $5
        entry.parentRef?.machineId ?? null, // $6
        entry.parentRef?.chartId ?? null, // $7
        entry.event ? Buffer.from(JSON.stringify(entry.event)) : null, // $8
        entry.state ? Buffer.from(JSON.stringify(entry.state)) : null, // $9
        entry.context ? Buffer.from(JSON.stringify(entry.context)) : null, // $10
        entry.actions ? Buffer.from(JSON.stringify(entry.actions)) : null, // $11
      ],
    );

    if (!result.rowCount) {
      throw new Error('Failed to write journal full entry');
    }
  }

  protected async emitJournalEntryNotification(
    id: number,
    ref: ChartReference,
  ): Promise<void> {
    const payload = JSON.stringify({
      id,
      machineId: ref.machineId,
      chartId: ref.chartId,
    });

    await this.runUpdateQuery(
      `SELECT pg_notify('${this.newJournalEntryChannel}', $1::text)`,
      [payload],
    );
  }

  /** Corresponds to {@link PostgresJournalRow} */
  private readonly journalEntrySqlSelectFields =
    '  "id", extract(epoch from "timestamp") * 1000 as "timestamp", ' +
    '  "machineId", "chartId", "event", ' +
    '  "state", "stateDelta", "context", "contextDelta", ' +
    '  "actions" ';

  public async readEntry(id: number): Promise<JournalEntry | null> {
    const result = await this.runReadQuery<PostgresJournalRow>(
      'SELECT ' +
        this.journalEntrySqlSelectFields +
        'FROM "journalEntries" WHERE "id"=$1',
      [id],
    );

    if (!result.rows.length) {
      return null;
    }

    return AbstractPostgresJournalPersistenceAdapter.parseSqlJournalRow(
      result.rows[0],
    );
  }

  /**
   * Builds a parameterized `JOIN (VALUES ...)` clause for matching an array
   * of chart references, appending the values to `params`.
   */
  private static chartReferenceValuesJoin(
    refs: ChartReference[],
    params: unknown[],
  ): string {
    return (
      'JOIN (VALUES ' +
      refs
        .map(({ machineId, chartId }) => {
          params.push(machineId, chartId);
          return `($${params.length - 1}, $${params.length})`;
        })
        .join(', ') +
      ') ' +
      '  AS "queryValues" ("queryMachineId", "queryChartId") ' +
      'ON "machineId" = "queryMachineId" AND "chartId" = "queryChartId" '
    );
  }

  public async queryEntries(query: JournalQuery): Promise<JournalEntry[]> {
    let result: { rows: PostgresJournalRow[] };

    if (Array.isArray(query)) {
      if (!query.length) {
        return [];
      }

      const params: unknown[] = [];
      result = await this.runReadQuery<PostgresJournalRow>(
        'SELECT ' +
          this.journalEntrySqlSelectFields +
          'FROM "journalEntries" ' +
          AbstractPostgresJournalPersistenceAdapter.chartReferenceValuesJoin(
            query,
            params,
          ),
        params,
      );
    } else {
      // The driver takes positional parameters only, so placeholders are
      // numbered in the order their conditions are appended
      const { params, nextParam } = createPositionalParameters();

      let sql =
        'SELECT ' +
        this.journalEntrySqlSelectFields +
        'FROM "journalEntries" ' +
        'WHERE TRUE ';

      if (query.ref !== undefined) {
        sql +=
          `  AND "machineId" = ${nextParam(query.ref.machineId)} ` +
          `AND "chartId" = ${nextParam(query.ref.chartId)} `;
      }
      if (query.afterId !== undefined) {
        sql += `  AND "id" > ${nextParam(query.afterId)}::bigint `;
      }
      if (query.afterAndIncludingId !== undefined) {
        sql += `  AND "id" >= ${nextParam(query.afterAndIncludingId)}::bigint `;
      }
      if (query.beforeId !== undefined) {
        sql += `  AND "id" < ${nextParam(query.beforeId)}::bigint `;
      }
      if (query.beforeAndIncludingId !== undefined) {
        sql += `  AND "id" <= ${nextParam(query.beforeAndIncludingId)}::bigint `;
      }
      if (query.updatedAfterAndIncluding !== undefined) {
        sql += `  AND "timestamp" >= to_timestamp(${nextParam(query.updatedAfterAndIncluding)}::decimal / 1000) `;
      }
      if (query.updatedBeforeAndIncluding !== undefined) {
        sql += `  AND "timestamp" <= to_timestamp(${nextParam(query.updatedBeforeAndIncluding)}::decimal / 1000) `;
      }

      sql += `ORDER BY "id" ${query.order ?? 'ASC'}`;

      if (query.offset !== undefined) {
        sql += `  OFFSET ${nextParam(query.offset)} `;
      }
      if (query.limit !== undefined) {
        sql += `  LIMIT ${nextParam(query.limit)} `;
      }

      result = await this.runReadQuery<PostgresJournalRow>(sql, params);
    }

    return result.rows.map(
      AbstractPostgresJournalPersistenceAdapter.parseSqlJournalRow,
    );
  }

  /** Corresponds to {@link PostgresFullStateRow} */
  private readonly fullStateEntrySqlSelectFields =
    '  "id", extract(epoch from "created") * 1000 as "created", ' +
    '  extract(epoch from "timestamp") * 1000 as "timestamp", ' +
    '  "ownerId", ' +
    '  "machineId", "chartId", "parentMachineId", "parentChartId", ' +
    '  "event", "state", "context", "actions" ';

  public async readFullState(
    ref: ChartReference,
  ): Promise<FullStateEntry | null> {
    const result = await this.runReadQuery<PostgresFullStateRow>(
      'SELECT ' +
        this.fullStateEntrySqlSelectFields +
        'FROM "fullJournalStates" ' +
        'WHERE "machineId" = $1 AND "chartId" = $2 ',
      [ref.machineId, ref.chartId],
    );

    if (!result.rows.length) {
      return null;
    }

    return AbstractPostgresJournalPersistenceAdapter.parseSqlFullStateRow(
      result.rows[0],
    );
  }

  public async queryFullStates(
    query: FullStateQuery,
  ): Promise<FullStateEntry[]> {
    let result: { rows: PostgresFullStateRow[] };

    if (Array.isArray(query)) {
      if (!query.length) {
        return [];
      }

      const params: unknown[] = [];
      result = await this.runReadQuery<PostgresFullStateRow>(
        'SELECT ' +
          this.fullStateEntrySqlSelectFields +
          'FROM "fullJournalStates" ' +
          AbstractPostgresJournalPersistenceAdapter.chartReferenceValuesJoin(
            query,
            params,
          ),
        params,
      );
    } else {
      // The driver takes positional parameters only, so placeholders are
      // numbered in the order their conditions are appended
      const { params, nextParam } = createPositionalParameters();

      let sql =
        'SELECT ' +
        this.fullStateEntrySqlSelectFields +
        'FROM "fullJournalStates" ' +
        'WHERE TRUE ';

      // In case of both machineId and ref, ref takes precedence
      if (query.ref !== undefined) {
        sql +=
          `  AND "machineId" = ${nextParam(query.ref.machineId)} ` +
          `AND "chartId" = ${nextParam(query.ref.chartId)} `;
      } else if (query.machineId !== undefined) {
        sql += `  AND "machineId" = ${nextParam(query.machineId)} `;
      }
      if (query.parentRef !== undefined) {
        sql +=
          `  AND "parentMachineId" = ${nextParam(query.parentRef.machineId)} ` +
          `AND "parentChartId" = ${nextParam(query.parentRef.chartId)} `;
      }
      if (query.afterId !== undefined) {
        sql += `  AND "id" > ${nextParam(query.afterId)}::bigint `;
      }
      if (query.afterAndIncludingId !== undefined) {
        sql += `  AND "id" >= ${nextParam(query.afterAndIncludingId)}::bigint `;
      }
      if (query.beforeId !== undefined) {
        sql += `  AND "id" < ${nextParam(query.beforeId)}::bigint `;
      }
      if (query.beforeAndIncludingId !== undefined) {
        sql += `  AND "id" <= ${nextParam(query.beforeAndIncludingId)}::bigint `;
      }
      if (query.createdAfterAndIncluding !== undefined) {
        sql += `  AND "created" >= to_timestamp(${nextParam(query.createdAfterAndIncluding)}::decimal / 1000) `;
      }
      if (query.createdBeforeAndIncluding !== undefined) {
        sql += `  AND "created" <= to_timestamp(${nextParam(query.createdBeforeAndIncluding)}::decimal / 1000) `;
      }
      if (query.updatedAfterAndIncluding !== undefined) {
        sql += `  AND "timestamp" >= to_timestamp(${nextParam(query.updatedAfterAndIncluding)}::decimal / 1000) `;
      }
      if (query.updatedBeforeAndIncluding !== undefined) {
        sql += `  AND "timestamp" <= to_timestamp(${nextParam(query.updatedBeforeAndIncluding)}::decimal / 1000) `;
      }

      sql += `ORDER BY "id" ${query.order ?? 'ASC'}`;

      if (query.offset !== undefined) {
        sql += `  OFFSET ${nextParam(query.offset)} `;
      }
      if (query.limit !== undefined) {
        sql += `  LIMIT ${nextParam(query.limit)} `;
      }

      result = await this.runReadQuery<PostgresFullStateRow>(sql, params);
    }

    return result.rows.map(
      AbstractPostgresJournalPersistenceAdapter.parseSqlFullStateRow,
    );
  }

  /**
   * @returns Number of deleted records
   */
  public async deleteByChart(ref: ChartReference): Promise<number> {
    const fullStateResult = await this.runUpdateQuery(
      'DELETE FROM "fullJournalStates" ' +
        'WHERE "machineId"=$1 AND "chartId"=$2',
      [ref.machineId, ref.chartId],
    );

    const journalEntryResult = await this.runUpdateQuery(
      'DELETE FROM "journalEntries" ' + 'WHERE "machineId"=$1 AND "chartId"=$2',
      [ref.machineId, ref.chartId],
    );

    return fullStateResult.rowCount + journalEntryResult.rowCount;
  }

  public async getCurrentTime(): Promise<number> {
    const result = await this.runReadQuery<{ time: number }>(
      'SELECT extract(epoch from transaction_timestamp()) * 1000 AS "time"',
    );

    if (!result.rows.length) {
      throw new Error('Failed to read current time from database');
    }

    return Number(result.rows[0].time);
  }

  static parseSqlJournalRow(row: PostgresJournalRow): JournalEntry {
    return {
      id: Number(row.id),
      timestamp: Number(row.timestamp),

      ref: {
        machineId: row.machineId,
        chartId: row.chartId,
      },

      event: row.event ? JSON.parse(decodeBytea(row.event)) : null,

      state: row.state ? JSON.parse(decodeBytea(row.state)) : null,
      context: row.context ? JSON.parse(decodeBytea(row.context)) : null,

      stateDelta: JSON.parse(decodeBytea(row.stateDelta)),
      contextDelta: JSON.parse(decodeBytea(row.contextDelta)),
      actions: row.actions ? JSON.parse(decodeBytea(row.actions)) : null,
    };
  }

  static parseSqlFullStateRow(row: PostgresFullStateRow): FullStateEntry {
    return {
      id: Number(row.id),
      created: Number(row.created),
      timestamp: Number(row.timestamp),

      ownerId: row.ownerId,

      ref: {
        machineId: row.machineId,
        chartId: row.chartId,
      },

      parentRef: row.parentChartId
        ? {
            machineId: row.parentMachineId,
            chartId: row.parentChartId,
          }
        : null,

      event: row.event ? JSON.parse(decodeBytea(row.event)) : null,
      state: row.state ? JSON.parse(decodeBytea(row.state)) : null,
      context: row.context ? JSON.parse(decodeBytea(row.context)) : null,
      actions: row.actions ? JSON.parse(decodeBytea(row.actions)) : null,
    };
  }
}
