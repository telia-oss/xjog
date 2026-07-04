import path from 'node:path';
import { PGlite, type PGliteOptions } from '@electric-sql/pglite';
import {
  type FullStateEntry,
  type FullStateQuery,
  type JournalEntry,
  type JournalEntryAutoFields,
  type JournalEntryInsertFields,
  JournalPersistenceAdapter,
  type JournalQuery,
} from '@telia-oss/xjog-journal-persistence';
import type {
  ChartReference,
  XJogStateChangeAction,
} from '@telia-oss/xjog-util';
import migrationRunner from 'node-pg-migrate';
import type { EventObject, StateValue } from 'xstate';
import type { PGliteFullStateRow } from './PGliteFullStateRow';
import type { PGliteJournalRow } from './PGliteJournalRow';

/**
 * Options for instantiating {@link PGliteJournalPersistenceAdapter}.
 */
export type PGliteJournalPersistenceAdapterOptions = {
  keyFrameInterval?: number;
};

/**
 * Use the static method `connect` to instantiate.
 * @hideconstructor
 */
export class PGliteJournalPersistenceAdapter extends JournalPersistenceAdapter {
  public readonly component = 'journal/persistence';
  public readonly type = 'pglite';

  private readonly stopObservingNewJournalEntries: Promise<() => Promise<void>>;

  public constructor(
    private readonly listenerConfig: PGliteOptions,
    private readonly connection: PGlite,
    private options: PGliteJournalPersistenceAdapterOptions,
  ) {
    super();

    this.stopObservingNewJournalEntries =
      this.startObservingNewJournalEntries();
  }

  /**
   * Create a connection to a [PostgreSql](https://www.postgresql.org/) database
   * and resolve to a JournalPersistenceAdapter that can be passed to the XJog
   * constructor.
   */
  static async connect(
    poolConfiguration: PGliteOptions = {},
    options: Partial<PGliteJournalPersistenceAdapterOptions> = {},
  ): Promise<PGliteJournalPersistenceAdapter> {
    const pool = await PGlite.create(poolConfiguration);
    const adapter = new PGliteJournalPersistenceAdapter(
      poolConfiguration,
      pool,
      options,
    );

    // TODO resolve separately
    options.keyFrameInterval ??= 100;

    try {
      await migrationRunner({
        dbClient: pool as any,
        migrationsTable: 'migrations_journal',
        dir: path.join(__dirname, './migrations'),
        singleTransaction: true,
        direction: 'up',
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
    await (await this.stopObservingNewJournalEntries)();

    await this.connection.close();
  }

  protected async insertEntry(
    entry: JournalEntryInsertFields,
  ): Promise<JournalEntryAutoFields> {
    const result = await this.connection.query<{
      id: number;
      timestamp: number;
    }>(
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
    const result = await this.connection.query(
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

    if (!result.affectedRows) {
      throw new Error('Failed to write journal full entry');
    }

    return;
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

    await this.connection.query(
      "SELECT pg_notify('new_journal_entry', $1::text)",
      [payload],
    );
  }

  /** These SQL fields correspond to {@link PostgresJournalRow} */
  private readonly journalEntrySqlSelectFields =
    '  "id", extract(epoch from "timestamp") * 1000 as "timestamp", ' +
    '  "machineId", "chartId", "event", ' +
    '  "state", "stateDelta", "context", "contextDelta", ' +
    '  "actions" ';

  public async readEntry(id: number): Promise<JournalEntry | null> {
    const result = await this.connection.query<PGliteJournalRow>(
      'SELECT ' +
        this.journalEntrySqlSelectFields +
        'FROM "journalEntries" WHERE "id"=$1',
      [id],
    );

    if (!result.rows.length) {
      return null;
    }

    return PGliteJournalPersistenceAdapter.parseSqlJournalRow(result.rows[0]);
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
    let result;

    if (Array.isArray(query)) {
      if (!query.length) {
        return [];
      }

      const params: unknown[] = [];
      result = await this.connection.query<PGliteJournalRow>(
        'SELECT ' +
          this.journalEntrySqlSelectFields +
          'FROM "journalEntries" ' +
          PGliteJournalPersistenceAdapter.chartReferenceValuesJoin(
            query,
            params,
          ),
        params,
      );
    } else {
      // PGlite takes positional parameters only, so placeholders are
      // numbered in the order their conditions are appended
      const params: unknown[] = [];
      const nextParam = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
      };

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

      sql += 'ORDER BY "id" ' + (query.order ?? 'ASC');

      if (query.offset !== undefined) {
        sql += `  OFFSET ${nextParam(query.offset)} `;
      }
      if (query.limit !== undefined) {
        sql += `  LIMIT ${nextParam(query.limit)} `;
      }

      result = await this.connection.query<PGliteJournalRow>(sql, params);
    }

    return result.rows.map(PGliteJournalPersistenceAdapter.parseSqlJournalRow);
  }

  private async startObservingNewJournalEntries(): Promise<
    () => Promise<void>
  > {
    const startTime = await this.getCurrentTime();

    let journalEntryIdPointer = 0;
    let fullStateEntryIdPointer = 0;

    const channel = 'new_journal_entry';

    const yieldJournalEntries = (journalEntries: JournalEntry[]) => {
      for (const journalEntry of journalEntries) {
        if (journalEntry.id < journalEntryIdPointer) {
          return;
        }
        journalEntryIdPointer = journalEntry.id;
        this.newJournalEntriesSubject.next(journalEntry);
      }
    };

    const yieldFullStateEntries = (fullStateEntries: FullStateEntry[]) => {
      for (const fullStateEntry of fullStateEntries) {
        if (fullStateEntry.id < fullStateEntryIdPointer) {
          return;
        }
        fullStateEntryIdPointer = fullStateEntry.id;
        this.newFullStateEntriesSubject.next(fullStateEntry);
      }
    };

    // Received a notification of a new journal entry. Failures are logged
    // rather than thrown: an exception here would surface as an unhandled
    // rejection inside PGlite's notification dispatch.
    this.connection.listen(channel, async () => {
      this.queryEntries({
        afterId: journalEntryIdPointer,
        updatedAfterAndIncluding: startTime,
        order: 'DESC',
      })
        .then((journalEntries: JournalEntry[]) => {
          if (journalEntries.length) {
            yieldJournalEntries(journalEntries);
          }
        })
        .catch((err) =>
          this.error('Failed to read new journal entries', { err }),
        );

      this.queryFullStates({
        afterId: fullStateEntryIdPointer,
        updatedAfterAndIncluding: startTime,
        order: 'DESC',
      })
        .then((fullStateEntries: FullStateEntry[]) => {
          if (fullStateEntries.length) {
            yieldFullStateEntries(fullStateEntries);
          }
        })
        .catch((err) => this.error('Failed to read new full states', { err }));
    });

    return async () => {
      await this.connection.unlisten(channel);
    };
  }

  /** These SQL fields correspond to {@link PostgresFullStateRow} */
  private readonly fullStateEntrySqlSelectFields =
    '  "id", extract(epoch from "created") * 1000 as "created", ' +
    '  extract(epoch from "timestamp") * 1000 as "timestamp", ' +
    '  "ownerId", ' +
    '  "machineId", "chartId", "parentMachineId", "parentChartId", ' +
    '  "event", "state", "context", "actions" ';

  public async readFullState(
    ref: ChartReference,
  ): Promise<FullStateEntry | null> {
    const result = await this.connection.query<PGliteFullStateRow>(
      'SELECT ' +
        this.fullStateEntrySqlSelectFields +
        'FROM "fullJournalStates" ' +
        'WHERE "machineId" = $1 AND "chartId" = $2 ',
      [ref.machineId, ref.chartId],
    );

    if (!result.rows.length) {
      return null;
    }

    return PGliteJournalPersistenceAdapter.parseSqlFullStateRow(result.rows[0]);
  }

  public async queryFullStates(
    query: FullStateQuery,
  ): Promise<FullStateEntry[]> {
    let result;

    if (Array.isArray(query)) {
      if (!query.length) {
        return [];
      }

      const params: unknown[] = [];
      result = await this.connection.query<PGliteFullStateRow>(
        'SELECT ' +
          this.fullStateEntrySqlSelectFields +
          'FROM "fullJournalStates" ' +
          PGliteJournalPersistenceAdapter.chartReferenceValuesJoin(
            query,
            params,
          ),
        params,
      );
    } else {
      // PGlite takes positional parameters only, so placeholders are
      // numbered in the order their conditions are appended
      const params: unknown[] = [];
      const nextParam = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
      };

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

      sql += 'ORDER BY "id" ' + (query.order ?? 'ASC');

      if (query.offset !== undefined) {
        sql += `  OFFSET ${nextParam(query.offset)} `;
      }
      if (query.limit !== undefined) {
        sql += `  LIMIT ${nextParam(query.limit)} `;
      }

      result = await this.connection.query<PGliteFullStateRow>(sql, params);
    }

    return result.rows.map(
      PGliteJournalPersistenceAdapter.parseSqlFullStateRow,
    );
  }

  /**
   * @returns Number of deleted records
   */
  public async deleteByChart(ref: ChartReference): Promise<number> {
    const fullStateResult = await this.connection.query(
      'DELETE FROM "fullJournalStates" ' +
        'WHERE "machineId"=$1 AND "chartId"=$2',
      [ref.machineId, ref.chartId],
    );

    const journalEntryResult = await this.connection.query(
      'DELETE FROM "journalEntries" ' + 'WHERE "machineId"=$1 AND "chartId"=$2',
      [ref.machineId, ref.chartId],
    );

    return (
      (fullStateResult.affectedRows ?? 0) +
      (journalEntryResult.affectedRows ?? 0)
    );
  }

  public async getCurrentTime(): Promise<number> {
    const result = await this.connection.query<{ time: number }>(
      'SELECT extract(epoch from transaction_timestamp()) * 1000 AS "time"',
    );

    if (!result.rows.length) {
      throw new Error('Failed to read current time from database');
    }

    return Number(result.rows[0].time);
  }

  static parseSqlJournalRow(row: PGliteJournalRow): JournalEntry {
    // bytea columns arrive as Uint8Array; String() would render them as
    // comma-joined byte values, so they must be decoded as UTF-8 text
    const decoder = new TextDecoder();

    return {
      id: Number(row.id),
      timestamp: Number(row.timestamp),

      ref: {
        machineId: row.machineId,
        chartId: row.chartId,
      },

      event: row.event ? JSON.parse(decoder.decode(row.event)) : null,

      state: row.state ? JSON.parse(decoder.decode(row.state)) : null,
      context: row.context ? JSON.parse(decoder.decode(row.context)) : null,

      stateDelta: JSON.parse(decoder.decode(row.stateDelta)),
      contextDelta: JSON.parse(decoder.decode(row.contextDelta)),
      actions: row.actions ? JSON.parse(decoder.decode(row.actions)) : null,
    };
  }

  static parseSqlFullStateRow(row: PGliteFullStateRow): FullStateEntry {
    const decoder = new TextDecoder();

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

      event: row.event ? JSON.parse(decoder.decode(row.event)) : null,
      state: row.state ? JSON.parse(decoder.decode(row.state)) : null,
      context: row.context ? JSON.parse(decoder.decode(row.context)) : null,
      actions: row.actions ? JSON.parse(decoder.decode(row.actions)) : null,
    };
  }
}
