import {
  ChartIdentifier,
  type ChartReference,
  decodeBytea,
} from '@telia-oss/xjog-util';
import type {
  EventObject,
  State,
  StateConfig,
  StateSchema,
  Typestate,
} from 'xstate';

import type { PersistedChart, PersistedDeferredEvent } from './EntryTypes';
import { PersistenceAdapter } from './PersistenceAdapter';

/**
 * Chart row directly from the SQL query
 */
type PostgresChartRow = {
  timestamp: number;
  ownerId: string;
  machineId: string;
  chartId: string;
  parentMachineId: string;
  parentChartId: string;
  state: Buffer | Uint8Array;
  paused: boolean;
};

/**
 * Deferred event row directly from the SQL query
 */
type PostgresDeferredEventRow = {
  id: number;
  machineId: string;
  chartId: string;
  eventId: string;
  eventTo: string;
  event: string;
  timestamp: number;
  delay: number;
  due: number;
  lock: string;
};

/**
 * Shared implementation of the pure-SQL core persistence methods, written
 * once against `$N` positional placeholders so it can run unmodified on any
 * Postgres-compatible driver. Concrete adapters (`core-pg`, `core-pglite`)
 * only need to supply a `runQuery` hook that executes SQL text plus a params
 * array against a given connection (or their default pool/connection when
 * none is given) and normalizes the driver's result shape.
 *
 * Stays generic over `ConnectionType` so each driver keeps its own connection
 * type and `withTransaction` callback signature unchanged.
 *
 * @hideconstructor
 */
export abstract class AbstractPostgresPersistenceAdapter<
  ConnectionType = unknown,
> extends PersistenceAdapter<ConnectionType> {
  /**
   * Run a parameterized SQL statement against the underlying driver and
   * return its rows and affected row count in a normalized shape. When
   * `connection` is omitted, implementations should fall back to their
   * default pool/connection.
   */
  protected abstract runQuery<T>(
    connection: ConnectionType | undefined,
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;

  public async countAliveInstances(
    connection?: ConnectionType,
  ): Promise<number> {
    const result = await this.runQuery<{ instanceCount: number }>(
      connection,
      'SELECT COUNT(*) AS "instanceCount" FROM "instances" WHERE "dying"=FALSE',
    );
    return Number(result.rows[0].instanceCount);
  }

  protected async insertInstance(
    id: string,
    connection?: ConnectionType,
  ): Promise<void> {
    await this.runQuery(
      connection,
      'INSERT INTO "instances" ("instanceId") VALUES ($1)',
      [id],
    );
  }

  protected async markInstanceDying(
    id: string,
    connection?: ConnectionType,
  ): Promise<void> {
    // Refresh "timestamp" so it marks when the row entered the dying state.
    // reapDeadInstances ages rows out relative to this, so a long-lived
    // instance is not reaped immediately after a graceful shutdown.
    await this.runQuery(
      connection,
      'UPDATE "instances" SET "dying"=TRUE, "timestamp"=now() ' +
        'WHERE "instanceId"=$1',
      [id],
    );
  }

  protected async reapDeadInstances(
    retentionMs: number,
    connection?: ConnectionType,
  ): Promise<void> {
    await this.runQuery(
      connection,
      'DELETE FROM "instances" ' +
        'WHERE "dying"=TRUE ' +
        'AND "timestamp" < now() - make_interval(secs => $1)',
      [retentionMs / 1000],
    );
  }

  protected async markAllInstancesDying(
    connection?: ConnectionType,
  ): Promise<void> {
    // Only flip rows that are currently alive, stamping when they became
    // dying. Rows already dying keep their original timestamp so they can age
    // out via reapDeadInstances instead of being perpetually refreshed.
    await this.runQuery(
      connection,
      'UPDATE "instances" SET "dying"=TRUE, "timestamp"=now() ' +
        'WHERE "dying"=FALSE',
    );
  }

  protected async updateInstanceHeartbeat(
    id: string,
    connection?: ConnectionType,
  ): Promise<void> {
    // For alive rows "timestamp" doubles as the liveness heartbeat; for dying
    // rows it is the time of death and must not be refreshed.
    await this.runQuery(
      connection,
      'UPDATE "instances" SET "timestamp"=now() ' +
        'WHERE "instanceId"=$1 AND "dying"=FALSE',
      [id],
    );
  }

  protected async markStaleInstancesAsDying(
    id: string,
    stalenessMs: number,
    connection?: ConnectionType,
  ): Promise<number> {
    const result = await this.runQuery(
      connection,
      'UPDATE "instances" SET "dying"=TRUE, "timestamp"=now() ' +
        'WHERE "dying"=FALSE AND "instanceId" <> $1 ' +
        'AND "timestamp" < now() - make_interval(secs => $2)',
      [id, stalenessMs / 1000],
    );
    return result.rowCount ?? 0;
  }

  protected async pauseChartsWithoutLiveOwner(
    connection?: ConnectionType,
  ): Promise<number> {
    const result = await this.runQuery(
      connection,
      'UPDATE "charts" SET "paused"=TRUE ' +
        'WHERE "paused"=FALSE AND ("ownerId" IS NULL OR "ownerId" NOT IN (' +
        '  SELECT "instanceId" FROM "instances" WHERE "dying"=FALSE' +
        '))',
    );
    return result.rowCount ?? 0;
  }

  protected async pauseChartsOwnedBy(
    id: string,
    connection?: ConnectionType,
  ): Promise<number> {
    const result = await this.runQuery(
      connection,
      'UPDATE "charts" SET "paused"=TRUE ' +
        'WHERE "paused"=FALSE AND "ownerId"=$1',
      [id],
    );
    return result.rowCount ?? 0;
  }

  protected async releaseDeferredEventsWithoutLiveOwner(
    connection?: ConnectionType,
  ): Promise<number> {
    const result = await this.runQuery(
      connection,
      'UPDATE "deferredEvents" SET "lock"=NULL ' +
        'WHERE "lock" IS NOT NULL AND "lock" NOT IN (' +
        '  SELECT "instanceId" FROM "instances" WHERE "dying"=FALSE' +
        ')',
    );
    return result.rowCount ?? 0;
  }

  protected async claimPausedChart(
    instanceId: string,
    ref: ChartReference,
    requireIdle: boolean,
    connection?: ConnectionType,
  ): Promise<boolean> {
    const result = await this.runQuery(
      connection,
      'UPDATE "charts" SET "ownerId"=$1, "paused"=FALSE ' +
        'WHERE "machineId"=$2 AND "chartId"=$3 AND "paused"=TRUE ' +
        (requireIdle
          ? 'AND NOT EXISTS (' +
            '  SELECT 1 FROM "ongoingActivities" ' +
            '  WHERE "machineId"=$2 AND "chartId"=$3' +
            ') '
          : ''),
      [instanceId, ref.machineId, ref.chartId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  protected async deleteOngoingActivitiesForChart(
    ref: ChartReference,
    connection?: ConnectionType,
  ): Promise<number> {
    const result = await this.runQuery(
      connection,
      'DELETE FROM "ongoingActivities" ' +
        'WHERE "machineId"=$1 AND "chartId"=$2',
      [ref.machineId, ref.chartId],
    );
    return result.rowCount ?? 0;
  }

  protected async markAllChartsPaused(
    connection?: ConnectionType,
  ): Promise<void> {
    await this.runQuery(connection, 'UPDATE "charts" SET "paused"=TRUE');
  }

  protected async countPausedCharts(
    connection?: ConnectionType,
  ): Promise<number> {
    const result = await this.runQuery<{ chartCount: number }>(
      connection,
      'SELECT COUNT(*) AS "chartCount" FROM "charts" WHERE "paused"=TRUE',
    );
    // Preserves the existing behavior of both drivers: the raw COUNT(*)
    // value (a numeric string on `pg`) is returned as-is, not coerced.
    return result.rows[0].chartCount;
  }

  protected async getPausedChartIds(
    connection?: ConnectionType,
  ): Promise<ChartReference[]> {
    const result = await this.runQuery<ChartReference>(
      connection,
      'SELECT "machineId", "chartId" FROM "charts" WHERE "paused"=TRUE',
    );

    return result.rows;
  }

  protected async getPausedChartWithNoOngoingActivitiesIds(
    connection?: ConnectionType,
  ): Promise<ChartReference[]> {
    const result = await this.runQuery<ChartReference>(
      connection,
      'SELECT "machineId", "chartId" FROM "charts" ' +
        'WHERE "paused" = TRUE AND NOT EXISTS (' +
        '  SELECT * FROM "ongoingActivities" ' +
        '  WHERE "machineId" = "charts"."machineId"' +
        '    AND "chartId" = "charts"."chartId"' +
        ')',
    );

    return result.rows;
  }

  public async countOwnCharts(
    instanceId: string,
    connection?: ConnectionType,
  ): Promise<number> {
    const result = await this.runQuery<{ chartCount: number }>(
      connection,
      'SELECT COUNT(*) AS "chartCount" FROM "charts" ' + 'WHERE "ownerId" = $1',
      [instanceId],
    );
    return Number(result.rows[0].chartCount);
  }

  protected async deleteOngoingActivitiesForPausedCharts(
    connection?: ConnectionType,
  ): Promise<number> {
    const result = await this.runQuery(
      connection,
      'DELETE FROM "ongoingActivities" WHERE NOT EXISTS (' +
        '  SELECT * FROM "charts" WHERE ' +
        '    "machineId" = "ongoingActivities"."machineId" AND' +
        '    "chartId" = "ongoingActivities"."chartId" AND' +
        '    "paused" = TRUE' +
        ')',
    );

    return result.rowCount ?? 0;
  }

  protected async changeOwnerAndResumePausedCharts(
    id: string,
    connection?: ConnectionType,
  ): Promise<void> {
    await this.runQuery(
      connection,
      'UPDATE "charts" ' +
        'SET "paused" = FALSE, "ownerId" = $1 ' +
        'WHERE "paused" = TRUE',
      [id],
    );
  }

  // TODO use row id:s instead, can use IN, faster; also do in batches
  protected async changeOwnerAndResumeCharts(
    instanceId: string,
    refs: ChartReference[],
    connection?: ConnectionType,
  ): Promise<void> {
    for (const ref of refs) {
      await this.runQuery(
        connection,
        'UPDATE "charts" ' +
          'SET "paused" = FALSE, "ownerId" = $1 ' +
          'WHERE "machineId" = $2 AND "chartId" = $3 ',
        [instanceId, ref.machineId, ref.chartId],
      );
    }
  }

  protected async insertChart<
    TContext,
    TEvent extends EventObject,
    TStateSchema extends State<any>,
    TTypeState extends Typestate<any>,
  >(
    instanceId: string,
    ref: ChartReference,
    parentRef: ChartReference | null,
    state: State<TContext, TEvent, TStateSchema, TTypeState>,
    connection?: ConnectionType,
  ): Promise<void> {
    await this.runQuery(
      connection,
      'INSERT INTO charts ' +
        '(' +
        '  "ownerId", "machineId", "chartId", ' +
        '  "parentMachineId", "parentChartId", "state"' +
        ') ' +
        'VALUES (' +
        '  $1, $2, $3, ' +
        '  $4, $5, $6 ' +
        ')',
      [
        instanceId,
        ref.machineId,
        ref.chartId,
        parentRef?.machineId ?? null,
        parentRef?.chartId ?? null,
        Buffer.from(JSON.stringify(state)),
      ],
    );
  }

  protected async chartExists(
    ref: ChartReference,
    connection?: ConnectionType,
  ): Promise<boolean> {
    const result = await this.runQuery(
      connection,
      'SELECT 1 FROM "charts" ' + 'WHERE "machineId" = $1 AND "chartId" = $2',
      [ref.machineId, ref.chartId],
    );

    return result.rows.length > 0;
  }

  protected async readChart<TContext, TEvent extends EventObject>(
    ref: ChartReference,
    connection?: ConnectionType,
  ): Promise<PersistedChart<TContext, TEvent> | null> {
    const result = await this.runQuery<PostgresChartRow>(
      connection,
      'SELECT * FROM "charts" ' + 'WHERE "machineId" = $1 AND "chartId" = $2 ',
      [ref.machineId, ref.chartId],
    );

    if (!result.rows.length) {
      return null;
    }

    return AbstractPostgresPersistenceAdapter.parseSqlChartRow<
      TContext,
      TEvent
    >(result.rows[0]);
  }

  protected async updateChartState<TContext, TEvent extends EventObject>(
    ref: ChartReference,
    state: State<TContext, TEvent, StateSchema<TContext>, Typestate<TContext>>,
    expectedOwnerId: string | null = null,
    connection?: ConnectionType,
  ): Promise<number> {
    const result = await this.runQuery(
      connection,
      'UPDATE "charts" SET "state" = $1 ' +
        'WHERE "machineId" = $2 AND "chartId" = $3 ' +
        (expectedOwnerId !== null ? 'AND "ownerId" = $4 ' : ''),
      [
        Buffer.from(JSON.stringify(state)),
        ref.machineId,
        ref.chartId,
        ...(expectedOwnerId !== null ? [expectedOwnerId] : []),
      ],
    );
    return result.rowCount ?? 0;
  }

  /**
   * @returns Number of deleted records
   */
  protected async deleteChart(
    ref: ChartReference,
    connection?: ConnectionType,
  ): Promise<number> {
    const result = await this.runQuery(
      connection,
      'DELETE FROM "charts" WHERE "machineId" = $1 AND "chartId" = $2',
      [ref.machineId, ref.chartId],
    );
    return result.rowCount ?? 0;
  }

  public async isActivityRegistered(
    ref: ChartReference,
    activityId: string,
    connection?: ConnectionType,
  ): Promise<boolean> {
    const result = await this.runQuery(
      connection,
      'SELECT 1 FROM "ongoingActivities" ' +
        'WHERE "machineId" = $1 AND "chartId" = $2 AND "activityId" = $3',
      [ref.machineId, ref.chartId, activityId],
    );

    return result.rows.length > 0;
  }

  public async registerActivity(
    ref: ChartReference,
    activityId: string,
    cid: string,
    connection?: ConnectionType,
  ): Promise<void> {
    await this.runQuery(
      connection,
      'INSERT INTO "ongoingActivities" ' +
        '  ("machineId", "chartId", "activityId") ' +
        'VALUES ($1, $2, $3) ' +
        'ON CONFLICT ("machineId", "chartId", "activityId") ' +
        '  DO NOTHING ',
      [ref.machineId, ref.chartId, activityId],
    );
  }

  public async unregisterActivity(
    ref: ChartReference,
    activityId: string,
    cid: string,
    connection?: ConnectionType,
  ): Promise<void> {
    await this.runQuery(
      connection,
      'DELETE FROM "ongoingActivities" ' +
        'WHERE "machineId" = $1 AND "chartId" = $2 AND "activityId" = $3',
      [ref.machineId, ref.chartId, activityId],
    );
  }

  /**
   * @returns Number of deleted records
   */
  protected async deleteAllDeferredEvents(
    ref: ChartReference,
    connection?: ConnectionType,
  ): Promise<number> {
    const result = await this.runQuery(
      connection,
      'DELETE FROM "deferredEvents" WHERE "machineId" = $1 AND "chartId" = $2',
      [ref.machineId, ref.chartId],
    );
    return result.rowCount ?? 0;
  }

  public async getExternalIdentifiers(
    key: string,
    ref: ChartReference,
    connection?: ConnectionType,
  ): Promise<string[]> {
    const result = await this.runQuery<{ value: string }>(
      connection,
      'SELECT "value" FROM "externalId" ' +
        'WHERE "machineId" = $1 AND "chartId" = $2 AND "key" = $3',
      [ref.machineId, ref.chartId, key],
    );
    return result.rows.map((row) => row.value);
  }

  public async getChartByExternalIdentifier(
    key: string,
    value: string,
    connection?: ConnectionType,
  ): Promise<ChartReference | null> {
    const result = await this.runQuery<ChartReference>(
      connection,
      'SELECT "machineId", "chartId" FROM "externalId" ' +
        'WHERE "key"=$1 AND "value"=$2 FOR SHARE',
      [key, value],
    );
    return result.rows[0] ?? null;
  }

  public async registerExternalId(
    ref: ChartReference,
    key: string,
    value: string,
    cid: string,
    connection?: ConnectionType,
  ): Promise<void> {
    await this.runQuery(
      connection,
      'INSERT INTO "externalId" ' +
        '  ("machineId", "chartId", "key", "value") ' +
        'VALUES ' +
        '  ($1, $2, $3, $4) ' +
        'ON CONFLICT ( ' +
        '  "key", "value" ' +
        ') DO UPDATE SET ' +
        '  "machineId" = $1, "chartId" = $2 ',
      [ref.machineId, ref.chartId, key, value],
    );
  }

  public async dropExternalId(
    key: string,
    value: string,
    cid: string,
    connection?: ConnectionType,
  ): Promise<number> {
    const result = await this.runQuery(
      connection,
      'DELETE FROM "externalId" WHERE "key"=$1 AND "value"=$2',
      [key, value],
    );
    return result.rowCount ?? 0;
  }

  /**
   * @returns Number of deleted records
   */
  protected async deleteExternalIdentifiers(
    ref: ChartReference,
    connection?: ConnectionType,
  ): Promise<number> {
    const result = await this.runQuery(
      connection,
      'DELETE FROM "externalId" WHERE "machineId"=$1 AND "chartId"=$2',
      [ref.machineId, ref.chartId],
    );
    return result.rowCount ?? 0;
  }

  /** Corresponds to {@link PostgresDeferredEventRow} */
  private readonly deferredEventSelectFields =
    '  "id", "machineId", "chartId", "lock", ' +
    '  "eventId", "eventTo", "event", "delay", ' +
    '  extract(epoch from "timestamp") * 1000 as "timestamp", ' +
    '  extract(epoch from "due") * 1000 as "due" ';

  protected async readDeferredEventRow(
    id: number,
    connection?: ConnectionType,
  ): Promise<PersistedDeferredEvent | null> {
    const result = await this.runQuery<PostgresDeferredEventRow>(
      connection,
      'SELECT ' +
        this.deferredEventSelectFields +
        'FROM "deferredEvents" ' +
        'WHERE "id"=$1 ' +
        'FOR SHARE',
      [id],
    );

    if (!result.rows.length) {
      return null;
    }

    return AbstractPostgresPersistenceAdapter.parseSqlDeferredEventRow(
      result.rows[0],
    );
  }

  protected async readDeferredEventByEventId(
    ref: ChartReference,
    eventId: string | number,
    connection?: ConnectionType,
  ): Promise<PersistedDeferredEvent | null> {
    const result = await this.runQuery<PostgresDeferredEventRow>(
      connection,
      'SELECT ' +
        this.deferredEventSelectFields +
        'FROM "deferredEvents" ' +
        'WHERE "machineId"=$1 AND "chartId"=$2 AND "eventId"=$3 ' +
        'FOR SHARE',
      [ref.machineId, ref.chartId, JSON.stringify(eventId)],
    );

    if (!result.rows.length) {
      return null;
    }

    return AbstractPostgresPersistenceAdapter.parseSqlDeferredEventRow(
      result.rows[0],
    );
  }

  /**
   * Read a batch of deferred events and mark them taken
   * @param instanceId
   * @param lookAhead
   * @param batchSize
   * @param connection
   * @protected
   */
  protected async readDeferredEventRowBatch(
    instanceId: string,
    lookAhead: number,
    batchSize: number,
    connection?: ConnectionType,
  ): Promise<PersistedDeferredEvent[]> {
    const result = await this.runQuery<PostgresDeferredEventRow>(
      connection,
      'WITH updated AS ( ' +
        '  UPDATE "deferredEvents" ' +
        '  SET "lock"=$3 ' +
        '  WHERE "id" IN ' +
        '  (' +
        '    SELECT "id" FROM "deferredEvents" ' +
        '    WHERE "due"<(transaction_timestamp() + make_interval(secs => $1::bigint / 1000)) ' +
        '      AND "lock" IS NULL ' +
        '    ORDER BY "due" ASC, "id" ASC ' +
        '    LIMIT $2::bigint' +
        '  ) ' +
        '  RETURNING * ' +
        ') ' +
        'SELECT ' +
        this.deferredEventSelectFields +
        'FROM updated ' +
        'ORDER BY "due" ASC, "id" ASC',
      [lookAhead, batchSize, instanceId],
    );

    return result.rows.map(
      AbstractPostgresPersistenceAdapter.parseSqlDeferredEventRow,
    );
  }

  public async releaseDeferredEvent(
    ref: ChartReference,
    eventId: string | number,
    connection?: ConnectionType,
  ): Promise<void> {
    await this.runQuery(
      connection,
      'UPDATE "deferredEvents" SET "lock"=NULL ' +
        'WHERE "machineId"=$1 AND "chartId"=$2 AND "eventId"=$3',
      [ref.machineId, ref.chartId, JSON.stringify(eventId)],
    );
  }

  protected async unmarkAllDeferredEventsForProcessing(
    connection?: ConnectionType,
  ): Promise<void> {
    await this.runQuery(connection, 'UPDATE "deferredEvents" SET "lock"=NULL');
  }

  protected async insertDeferredEvent(
    deferredEventRow: Omit<PersistedDeferredEvent, 'id'>,
    connection?: ConnectionType,
  ): Promise<PersistedDeferredEvent | null> {
    const timestamp = deferredEventRow.timestamp ?? Date.now();
    const due =
      deferredEventRow.due ?? timestamp + Math.ceil(deferredEventRow.delay);

    let toFieldStringRepresentation = null;

    if (deferredEventRow.eventTo) {
      if (
        typeof deferredEventRow.eventTo === 'string' ||
        typeof deferredEventRow.eventTo === 'number'
      ) {
        toFieldStringRepresentation = deferredEventRow.eventTo;
      } else {
        const chartIdentifierFromToField = ChartIdentifier.from(
          deferredEventRow.eventTo,
        );
        if (chartIdentifierFromToField) {
          toFieldStringRepresentation =
            chartIdentifierFromToField.uri.toString();
        } else if (
          typeof deferredEventRow.eventTo === 'object' &&
          'id' in deferredEventRow.eventTo &&
          deferredEventRow.eventTo.id
        ) {
          toFieldStringRepresentation = deferredEventRow.eventTo.id;
        }
      }
    }

    const result = await this.runQuery<PostgresDeferredEventRow>(
      connection,
      'INSERT INTO "deferredEvents" (' +
        '  "machineId", "chartId", ' +
        '  "eventId", "eventTo", "event", ' +
        '  "timestamp", "delay", ' +
        '  "due" ' +
        ') VALUES (' +
        '  $1, $2, ' +
        '  $3, $4, $5, ' +
        '  $6::timestamptz, $7::bigint, ' +
        '  $8::timestamptz' +
        ') ' +
        'RETURNING ' +
        this.deferredEventSelectFields,
      [
        deferredEventRow.ref.machineId,
        deferredEventRow.ref.chartId,

        JSON.stringify(deferredEventRow.eventId),
        JSON.stringify(toFieldStringRepresentation),
        JSON.stringify(deferredEventRow.event),

        new Date(timestamp).toISOString(),
        Math.ceil(deferredEventRow.delay),
        new Date(due).toISOString(),
      ],
    );

    if (!result.rows.length) {
      return null;
    }

    return AbstractPostgresPersistenceAdapter.parseSqlDeferredEventRow(
      result.rows[0],
    );
  }

  protected async deleteDeferredEvent(
    id: number,
    connection?: ConnectionType,
  ): Promise<number> {
    const result = await this.runQuery(
      connection,
      'DELETE FROM "deferredEvents" WHERE "id"=$1 ',
      [id],
    );

    return result.rowCount ?? 0;
  }

  private static parseSqlChartRow<TContext, TEvent extends EventObject>(
    row: PostgresChartRow,
  ): PersistedChart<TContext, TEvent> {
    return {
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

      state: JSON.parse(decodeBytea(row.state)) as StateConfig<
        TContext,
        TEvent
      >,

      paused: row.paused,
    };
  }

  private static parseSqlDeferredEventRow(
    row: PostgresDeferredEventRow,
  ): PersistedDeferredEvent {
    return {
      id: row.id,
      timestamp: Number(row.timestamp),
      ref: {
        machineId: row.machineId,
        chartId: row.chartId,
      },
      eventId: JSON.parse(row.eventId),
      eventTo: JSON.parse(row.eventTo),
      event: JSON.parse(row.event),
      delay: row.delay,
      due: row.due,
      lock: row.lock,
    };
  }
}
