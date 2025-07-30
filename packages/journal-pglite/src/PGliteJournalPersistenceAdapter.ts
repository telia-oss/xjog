import { EventObject, StateValue } from 'xstate';
import { ChartReference, XJogStateChangeAction } from '@samihult/xjog-util';
import migrationRunner from 'node-pg-migrate';
import path from 'path';

import {
  FullStateEntry,
  FullStateQuery,
  JournalEntry,
  JournalEntryAutoFields,
  JournalEntryInsertFields,
  JournalPersistenceAdapter,
  JournalQuery,
} from '@samihult/xjog-journal-persistence';

import { PGlite, PGliteOptions } from '@electric-sql/pglite';
import { PGliteFullStateRow } from './PGliteFullStateRow';
import { PGliteJournalRow } from './PGliteJournalRow';

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
    await (
      await this.stopObservingNewJournalEntries
    )();

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
      "SELECT pg_notify('new_journal_entry', $1:text)",
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
   * Including the node-pg helper function
   * https://github.com/brianc/node-postgres/blob/1b2bedc9c86b7378288e704252a8e4fafa27aa34/packages/pg/lib/utils.js#L175
   */
  private escapeLiteral(str: string): string {
    let hasBackslash = false;
    let escaped = "'";

    if (str == null) {
      return "''";
    }

    if (typeof str !== 'string') {
      return "''";
    }

    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (c === "'") {
        escaped += c + c;
      } else if (c === '\\') {
        escaped += c + c;
        hasBackslash = true;
      } else {
        escaped += c;
      }
    }

    escaped += "'";

    if (hasBackslash === true) {
      escaped = ' E' + escaped;
    }

    return escaped;
  }

  public async queryEntries(query: JournalQuery): Promise<JournalEntry[]> {
    let result;

    if (Array.isArray(query)) {
      if (!query.length) {
        return [];
      }

      result = await this.connection.query<PGliteJournalRow>(
        'SELECT ' +
          this.journalEntrySqlSelectFields +
          'FROM "journalEntries" ' +
          'JOIN (VALUES ' +
          query
            .map(
              ({ machineId, chartId }) =>
                `(${this.escapeLiteral(machineId)}, ` +
                `${this.escapeLiteral(chartId)})`,
            )
            .join(', ') +
          ') ' +
          '  AS "queryValues" ("queryMachineId", "queryChartId") ' +
          'ON "machineId" = "queryMachineId" AND "chartId" = "queryChartId" ',
      );
    } else {
      result = await this.connection.query<PGliteJournalRow>(
        'SELECT ' +
          this.journalEntrySqlSelectFields +
          'FROM "journalEntries" ' +
          'WHERE TRUE ' +
          (query.ref !== undefined
            ? '  AND "machineId" = $1 AND "chartId" = $2 '
            : '') +
          (query.afterId !== undefined ? '  AND "id" > $3::bigint ' : '') +
          (query.afterAndIncludingId !== undefined
            ? '  AND "id" >= $4::bigint '
            : '') +
          (query.beforeId !== undefined ? '  AND "id" < $5::bigint ' : '') +
          (query.beforeAndIncludingId !== undefined
            ? '  AND "id" <= $6::bigint '
            : '') +
          (query.updatedAfterAndIncluding !== undefined
            ? '  AND "timestamp" >= to_timestamp($7::decimal / 1000) '
            : '') +
          (query.updatedBeforeAndIncluding !== undefined
            ? '  AND "timestamp" <= to_timestamp($8::decimal / 1000) '
            : '') +
          'ORDER BY "id" ' +
          (query.order ?? 'ASC') +
          (query.offset !== undefined ? '  OFFSET $9 ' : '') +
          (query.limit !== undefined ? '  LIMIT $10 ' : ''),
        [
          query.ref?.machineId, // $1
          query.ref?.chartId, // $2
          query.afterId, // $3
          query.afterAndIncludingId, // $4
          query.beforeId, // $5
          query.beforeAndIncludingId, // $6
          query.updatedAfterAndIncluding, // $7
          query.updatedBeforeAndIncluding, // $8
          query.offset, // $9
          query.limit, // $10
        ],
      );
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

    // Received a notification of a new journal entry
    this.connection.listen(channel, async () => {
      this.queryEntries({
        afterId: journalEntryIdPointer,
        updatedAfterAndIncluding: startTime,
        order: 'DESC',
      }).then((journalEntries: JournalEntry[]) => {
        if (journalEntries.length) {
          yieldJournalEntries(journalEntries);
        }
      });

      this.queryFullStates({
        afterId: fullStateEntryIdPointer,
        updatedAfterAndIncluding: startTime,
        order: 'DESC',
      }).then((fullStateEntries: FullStateEntry[]) => {
        if (fullStateEntries.length) {
          yieldFullStateEntries(fullStateEntries);
        }
      });
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

      result = await this.connection.query<PGliteFullStateRow>(
        'SELECT ' +
          this.fullStateEntrySqlSelectFields +
          'FROM "fullJournalStates" ' +
          'JOIN (VALUES ' +
          query
            .map(
              ({ machineId, chartId }) =>
                `(${this.escapeLiteral(machineId)}, ` +
                `${this.escapeLiteral(chartId)})`,
            )
            .join(', ') +
          ') ' +
          '  AS "queryValues" ("queryMachineId", "queryChartId") ' +
          'ON "machineId" = "queryMachineId" AND "chartId" = "queryChartId" ',
      );
    } else {
      result = await this.connection.query<PGliteFullStateRow>(
        'SELECT ' +
          this.fullStateEntrySqlSelectFields +
          'FROM "fullJournalStates" ' +
          'WHERE TRUE ' +
          (query.ref !== undefined && query.machineId === undefined
            ? '  AND "machineId" = $1 AND "chartId" = $2 '
            : '') +
          (query.parentRef !== undefined
            ? '  AND "parentMachineId" = $3 AND "parentChartId" = $4 '
            : '') +
          // In case of both machineId and ref, ref takes precedence
          (query.machineId !== undefined && query.ref === undefined
            ? '  AND "machineId" = $5 '
            : '') +
          (query.afterId !== undefined ? '  AND "id" > $6::bigint ' : '') +
          (query.afterAndIncludingId !== undefined
            ? '  AND "id" >= $7::bigint '
            : '') +
          (query.beforeId !== undefined ? '  AND "id" < $8::bigint ' : '') +
          (query.beforeAndIncludingId !== undefined
            ? '  AND "id" <= $9::bigint '
            : '') +
          (query.createdAfterAndIncluding !== undefined
            ? '  AND "created" >= to_timestamp($10::decimal / 1000) '
            : '') +
          (query.createdBeforeAndIncluding !== undefined
            ? '  AND "created" <= to_timestamp($11::decimal / 1000) '
            : '') +
          (query.updatedAfterAndIncluding !== undefined
            ? '  AND "timestamp" >= to_timestamp($12::decimal / 1000)  '
            : '') +
          (query.updatedBeforeAndIncluding !== undefined
            ? '  AND "timestamp" <= to_timestamp($13::decimal / 1000) '
            : '') +
          'ORDER BY "id" ' +
          (query.order ?? 'ASC') +
          (query.offset !== undefined ? '  OFFSET $13 ' : '') +
          (query.limit !== undefined ? '  LIMIT $14 ' : ''),
        [
          query.ref?.machineId ?? query.machineId, // $1
          query.ref?.chartId, // $2
          query.parentRef?.machineId, // $3
          query.parentRef?.chartId, // $4
          query.afterId, // $5
          query.afterAndIncludingId, // $6
          query.beforeId, // $7
          query.beforeAndIncludingId, // $8
          query.createdAfterAndIncluding, // $9
          query.createdBeforeAndIncluding, // $10
          query.updatedAfterAndIncluding, // $11
          query.updatedBeforeAndIncluding, // $12
          query.offset, // $13
          query.limit, // $14
        ],
      );
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

  public async record(
    ownerId: string,
    ref: ChartReference,
    parentRef: ChartReference | null,
    event: EventObject | null,
    oldState: StateValue | null,
    oldContext: any | null,
    newState: StateValue | null,
    newContext: unknown | null,
    actions: XJogStateChangeAction[],
    cid?: string,
  ): Promise<void> {
    // TODO: Figure out what data to pass in here
    const now = new Date().getTime();
    const entry = await this.updateFullState({
      id: 1,
      created: now,
      timestamp: now,
      ownerId,
      ref,
      parentRef,
      event,
      state: newState,
      context: newContext,
      actions,
    });
  }

  static parseSqlJournalRow(row: PGliteJournalRow): JournalEntry {
    return {
      id: Number(row.id),
      timestamp: Number(row.timestamp),

      ref: {
        machineId: row.machineId,
        chartId: row.chartId,
      },

      event: JSON.parse(String(row.event)),

      state: row.state ? JSON.parse(String(row.state)) : null,
      context: row.context ? JSON.parse(String(row.context)) : null,

      stateDelta: JSON.parse(String(row.stateDelta)),
      contextDelta: JSON.parse(String(row.contextDelta)),
      actions: row.actions ? JSON.parse(String(row.actions)) : null,
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
