import { randomUUID } from 'node:crypto';
import {
	type EventObject,
	State,
	type StateSchema,
	type Typestate,
} from 'xstate';

import {
  AbstractPersistenceAdapter,
  type ChartReference,
  getCorrelationIdentifier,
} from '@samihult/xjog-util';

import type { PersistedChart, PersistedDeferredEvent } from './EntryTypes';

/**
 * How long an instance row may stay marked `dying` (measured from when it
 * entered the dying state, which `markInstanceDying`/`markAllInstancesDying`
 * stamp onto `timestamp`) before it is reaped on the next startup. Long enough
 * that an instance just overthrown still sees its own death note and shuts
 * down before its row disappears, short enough to bound `instances` growth.
 */
export const DEAD_INSTANCE_RETENTION_MS = 60 * 60 * 1000;

/**
 * Thrown when a state write is fenced off because the chart is no longer
 * owned by the writing instance — a sibling adopted it (stale-instance
 * takeover, deploy handoff) or it was destroyed. The caller must drop its
 * in-memory copy of the chart; the persisted state belongs to the new owner.
 */
export class ChartOwnershipLostError extends Error {
  public constructor(
    public readonly ref: ChartReference,
    public readonly instanceId: string,
  ) {
    super(
      `Chart ${ref.machineId}/${ref.chartId} is no longer owned by ` +
        `instance ${instanceId}; refusing to overwrite its state`,
    );
    this.name = 'ChartOwnershipLostError';
  }

  /**
   * Name-based type guard. Package managers can resolve two copies of this
   * package into one dependency tree, and `instanceof` fails across copies —
   * match on the error name so consumers can rely on the check.
   */
  public static is(error: unknown): error is ChartOwnershipLostError {
    return (
      error instanceof ChartOwnershipLostError ||
      (error instanceof Error && error.name === 'ChartOwnershipLostError')
    );
  }
}

/**
 * Abstract adapter class for XJog persistence.
 * @hideconstructor
 */
export abstract class PersistenceAdapter<
  ConnectionType = unknown,
> extends AbstractPersistenceAdapter {
  ////////////////////////////////////////////////////////////////////////////////
  // Abstract low-level methods that need to be implemented by a concrete subclass

  /**
   * Executes the routine within a transaction. In case of an error,
   * rolls back. Otherwise, commits at the end. Inside, use the client,
   * if applicable.
   * @abstract
   */
  public abstract withTransaction<ReturnType>(
    routine: (client: ConnectionType) => Promise<ReturnType> | ReturnType,
  ): Promise<ReturnType>;

  /**
   * @abstract
   */
  public abstract countAliveInstances(
    connection?: ConnectionType,
  ): Promise<number>;

  /**
   * @abstract
   */
  protected abstract insertInstance(
    id: string,
    connection?: ConnectionType,
  ): Promise<void>;

  /**
   * Mark a single instance as dying so it stops counting as alive
   * ({@link countAliveInstances} excludes `dying=TRUE` rows). Used on graceful
   * shutdown to deregister the departing instance.
   *
   * @abstract
   */
  protected abstract markInstanceDying(
    id: string,
    connection?: ConnectionType,
  ): Promise<void>;

  /**
   * Delete instance rows that have been marked dying for longer than
   * `retentionMs`. Bounds growth of the `instances` table and lets rows left
   * behind by killed processes age out. Never touches `dying=FALSE` rows.
   *
   * @abstract
   */
  protected abstract reapDeadInstances(
    retentionMs: number,
    connection?: ConnectionType,
  ): Promise<void>;

  /**
   * @abstract
   */
  protected abstract markAllInstancesDying(
    connection?: ConnectionType,
  ): Promise<void>;

  /**
   * Refresh the instance row's `timestamp` so it counts as recently alive.
   * Must not touch rows already marked dying.
   *
   * @abstract
   */
  protected abstract updateInstanceHeartbeat(
    id: string,
    connection?: ConnectionType,
  ): Promise<void>;

  /**
   * Mark alive instances (other than the caller) whose heartbeat `timestamp`
   * is older than `stalenessMs` as dying, stamping `timestamp` with the time
   * of death like {@link markInstanceDying} does.
   *
   * @abstract
   * @returns Number of instances marked dying
   */
  protected abstract markStaleInstancesAsDying(
    id: string,
    stalenessMs: number,
    connection?: ConnectionType,
  ): Promise<number>;

  /**
   * Pause every unpaused chart whose `ownerId` is not an alive instance
   * (owner missing, reaped, or marked dying). Paused charts are up for
   * adoption by the reconciler.
   *
   * @abstract
   * @returns Number of charts paused
   */
  protected abstract pauseChartsWithoutLiveOwner(
    connection?: ConnectionType,
  ): Promise<number>;

  /**
   * Pause every unpaused chart owned by the given instance. Used on graceful
   * shutdown to offer the instance's charts for adoption.
   *
   * @abstract
   * @returns Number of charts paused
   */
  protected abstract pauseChartsOwnedBy(
    id: string,
    connection?: ConnectionType,
  ): Promise<number>;

  /**
   * Release deferred-event locks held by instances that are not alive, so a
   * surviving instance's deferred-event loop can pick the events up.
   *
   * @abstract
   * @returns Number of locks released
   */
  protected abstract releaseDeferredEventsWithoutLiveOwner(
    connection?: ConnectionType,
  ): Promise<number>;

  /**
   * Atomically claim a paused chart for the given instance: set its owner and
   * resume it, but only if it is still paused (and, when `requireIdle`, has
   * no ongoing activities). Exactly one of several concurrent claimants wins.
   *
   * @abstract
   * @returns True if this call claimed the chart
   */
  protected abstract claimPausedChart(
    instanceId: string,
    ref: ChartReference,
    requireIdle: boolean,
    connection?: ConnectionType,
  ): Promise<boolean>;

  /**
   * Delete the ongoing-activity rows of a single chart. Used after forcibly
   * adopting it, since the previous owner is gone and cannot stop them.
   *
   * @abstract
   * @returns Number of deleted rows
   */
  protected abstract deleteOngoingActivitiesForChart(
    ref: ChartReference,
    connection?: ConnectionType,
  ): Promise<number>;

  /**
   * Function that notifies the callback when
   * this instance is marked as dying
   *
   * @abstract
   * @returns A function to stop listening
   */
  public abstract onDeathNote(
    instanceId: string,
    callback: () => void,
  ): () => void;

  /**
   * @abstract
   */
  protected abstract insertChart<
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
  ): Promise<void>;

  /**
   * @abstract
   */
  protected abstract chartExists(
    ref: ChartReference,
    connection?: ConnectionType,
  ): Promise<boolean>;

  /**
   * @abstract
   */
  protected abstract readChart<TContext, TEvent extends EventObject>(
    ref: ChartReference,
    connection?: ConnectionType,
  ): Promise<PersistedChart<TContext, TEvent> | null>;

  /**
   * Persist the chart's state. When `expectedOwnerId` is given, the write is
   * fenced: it only applies while the chart is still owned by that instance.
   *
   * @abstract
   * @returns Number of updated rows (0 when the fence rejected the write)
   */
  protected abstract updateChartState<TContext, TEvent extends EventObject>(
    ref: ChartReference,
    serializedState: State<
      TContext,
      TEvent,
      StateSchema<TContext>,
      Typestate<TContext>
    >,
    expectedOwnerId?: string | null,
    connection?: ConnectionType,
  ): Promise<number>;

  /**
   * @abstract
   */
  protected abstract markAllChartsPaused(
    connection?: ConnectionType,
  ): Promise<void>;

  /**
   * @abstract
   */
  protected abstract countPausedCharts(
    connection?: ConnectionType,
  ): Promise<number>;

  /**
   * @abstract
   * @group Charts
   */
  protected abstract getPausedChartIds(
    connection?: ConnectionType,
  ): Promise<ChartReference[]>;

  /**
   * @abstract
   */
  protected abstract getPausedChartWithNoOngoingActivitiesIds(
    connection?: ConnectionType,
  ): Promise<ChartReference[]>;

  /**
   */
  public abstract countOwnCharts(
    instanceId: string,
    connection?: ConnectionType,
  ): Promise<number>;

  /**
   * @abstract
   * @returns Number of deleted rows
   */
  protected abstract deleteOngoingActivitiesForPausedCharts(
    connection?: ConnectionType,
  ): Promise<number>;

  /**
   * @abstract
   */
  protected abstract changeOwnerAndResumePausedCharts(
    id: string,
    connection?: ConnectionType,
  ): Promise<void>;

  /**
   * @abstract
   */
  protected abstract changeOwnerAndResumeCharts(
    instanceId: string,
    refs: ChartReference[],
    connection?: ConnectionType,
  ): Promise<void>;

  /**
   * @abstract
   * @returns Number of deleted records
   */
  protected abstract deleteChart(
    ref: ChartReference,
    connection?: ConnectionType,
  ): Promise<number>;

  /**
   * @abstract
   * @returns Check if an activity is registered as ongoing
   */
  public abstract isActivityRegistered(
    ref: ChartReference,
    activityId: string,
    connection?: ConnectionType,
  ): Promise<boolean>;

  /**
   * @abstract
   * @returns Register a new ongoing activity
   */
  public abstract registerActivity(
    ref: ChartReference,
    activityId: string,
    cid: string,
    connection?: ConnectionType,
  ): Promise<void>;

  /**
   * @abstract
   * @returns Unregister a new ongoing activity
   */
  public abstract unregisterActivity(
    ref: ChartReference,
    activityId: string,
    cid: string,
    connection?: ConnectionType,
  ): Promise<void>;

  /**
   * @abstract
   * @returns Inserted id
   */
  protected abstract insertDeferredEvent(
    deferredEventRow: Omit<PersistedDeferredEvent, 'id'>,
    connection?: ConnectionType,
  ): Promise<PersistedDeferredEvent | null>;

  /**
   * Read single deferred event
   *
   * @abstract
   * @param id
   * @param connection
   */
  protected abstract readDeferredEventRow(
    id: number,
    connection?: ConnectionType,
  ): Promise<PersistedDeferredEvent | null>;

  protected abstract readDeferredEventByEventId(
    ref: ChartReference,
    eventId: string | number,
    connection?: ConnectionType,
  ): Promise<PersistedDeferredEvent | null>;

  /**
   * In ascending order by due time.
   *
   * @abstract
   */
  protected abstract readDeferredEventRowBatch(
    instanceId: string,
    lookAhead: number,
    batchSize: number,
    connection?: ConnectionType,
  ): Promise<PersistedDeferredEvent[]>;

  /**
   * @abstract
   * @group Deferred events
   */
  // protected abstract markDeferredEventBatchForProcessing(
  //   instanceId: string,
  //   lookAhead: number,
  //   batchSize: number,
  //   connection?: ConnectionType,
  // ): Promise<void>;

  /**
   * @abstract
   */
  public abstract releaseDeferredEvent(
    ref: ChartReference,
    eventId: string | number,
    connection?: ConnectionType,
  ): Promise<void>;

  /**
   * @abstract
   */
  protected abstract unmarkAllDeferredEventsForProcessing(
    connection?: ConnectionType,
  ): Promise<void>;

  /**
   * @abstract
   * @returns Number of deleted records
   */
  protected abstract deleteDeferredEvent(
    id: number,
    connection?: ConnectionType,
  ): Promise<number>;

  /**
   * @abstract
   * @returns Number of deleted records
   */
  protected abstract deleteAllDeferredEvents(
    ref: ChartReference,
    connection?: ConnectionType,
  ): Promise<number>;

  /**
   * @abstract
   */
  public abstract getExternalIdentifiers(
    key: string,
    ref: ChartReference,
    connection?: ConnectionType,
  ): Promise<string[]>;

  public abstract registerExternalId(
    ref: ChartReference,
    key: string,
    value: string,
    cid: string,
  ): Promise<void>;

  public abstract dropExternalId(
    key: string,
    value: string,
    cid: string,
  ): Promise<number>;

  // TODO rename!
  /**
   * @abstract
   * @group External identifiers
   */
  public abstract getChartByExternalIdentifier(
    key: string,
    value: string,
    connection?: ConnectionType,
  ): Promise<ChartReference | null>;

  /**
   * @abstract
   * @returns Number of deleted records
   */
  protected abstract deleteExternalIdentifiers(
    ref: ChartReference,
    connection?: ConnectionType,
  ): Promise<number>;

  /////////////////////////////////////////////////////////////////////////////
  // Higher-level methods that can to be overridden by a subclass, if necessary

  public async overthrowOtherInstances(
    instanceId: string,
    cid: string,
  ): Promise<void> {
    const trace = (args: Record<string, any>) =>
      this.trace({ cid, in: 'overthrowOtherInstances', ...args });

    await this.withTransaction(async (connection) => {
      trace({ message: 'Marking all instances dying' });
      await this.markAllInstancesDying(connection);

      trace({ message: 'Marking all charts paused' });
      await this.markAllChartsPaused(connection);

			// Bug fix: release deferred event locks left behind by instances that
			// were killed without graceful shutdown. Without this, events locked
			// by dead instance UUIDs are permanently stuck since new instances
			// only query WHERE lock IS NULL (releaseAll/releaseAllDeferredEvents
			// is only called from XJog.shutdown(), which never runs on SIGKILL).
			trace({ message: 'Releasing all deferred event locks' });
			await this.unmarkAllDeferredEventsForProcessing(connection);

      trace({ message: 'Adding the instance to the list' });
      await this.insertInstance(instanceId, connection);

      // Reap instance rows that have been dying past the retention window.
      // These are left behind by graceful shutdowns and by processes killed
      // without one; without this the table grows one row per process start.
      trace({ message: 'Reaping long-dead instances' });
      await this.reapDeadInstances(DEAD_INSTANCE_RETENTION_MS, connection);
    });

    trace({ message: 'Done' });
  }

  /**
   * Register this instance as alive without disturbing live siblings. The
   * non-violent counterpart of {@link overthrowOtherInstances}: no instance
   * is marked dying and no chart is paused. Reaps long-dead rows in passing.
   */
  public async registerInstance(instanceId: string, cid: string): Promise<void> {
    const trace = (args: Record<string, any>) =>
      this.trace({ cid, in: 'registerInstance', ...args });

    await this.withTransaction(async (connection) => {
      trace({ message: 'Adding the instance to the list' });
      await this.insertInstance(instanceId, connection);

      trace({ message: 'Reaping long-dead instances' });
      await this.reapDeadInstances(DEAD_INSTANCE_RETENTION_MS, connection);
    });

    trace({ message: 'Done' });
  }

  /**
   * Refresh this instance's liveness heartbeat. Called periodically by the
   * adoption reconciler; an instance whose heartbeat goes stale is eventually
   * marked dying by a sibling via {@link markStaleInstancesDying}.
   */
  public async heartbeatInstance(instanceId: string): Promise<void> {
    await this.updateInstanceHeartbeat(instanceId);
  }

  /**
   * Mark alive siblings with a stale heartbeat as dying. Their charts become
   * orphans and get paused by {@link pauseOrphanedCharts} on the same
   * reconciler pass; their own death-note poll makes them shut down.
   */
  public async markStaleInstancesDying(
    instanceId: string,
    stalenessMs: number,
    cid: string = getCorrelationIdentifier(),
  ): Promise<number> {
    const trace = (args: Record<string, any>) =>
      this.trace({ cid, in: 'markStaleInstancesDying', ...args });

    const markedCount = await this.markStaleInstancesAsDying(
      instanceId,
      stalenessMs,
    );

    if (markedCount > 0) {
      trace({ message: 'Marked stale instances dying', markedCount });
    }

    return markedCount;
  }

  /**
   * Pause charts whose owner is not alive so they can be adopted.
   */
  public async pauseOrphanedCharts(
    cid: string = getCorrelationIdentifier(),
  ): Promise<number> {
    const trace = (args: Record<string, any>) =>
      this.trace({ cid, in: 'pauseOrphanedCharts', ...args });

    const pausedCount = await this.pauseChartsWithoutLiveOwner();

    if (pausedCount > 0) {
      trace({ message: 'Paused orphaned charts', pausedCount });
    }

    return pausedCount;
  }

  /**
   * Pause this instance's own charts, offering them for adoption by a
   * surviving sibling. Called on graceful shutdown.
   */
  public async pauseOwnCharts(
    instanceId: string,
    cid: string = getCorrelationIdentifier(),
  ): Promise<number> {
    const trace = (args: Record<string, any>) =>
      this.trace({ cid, in: 'pauseOwnCharts', ...args });

    const pausedCount = await this.pauseChartsOwnedBy(instanceId);

    trace({ message: 'Paused own charts', pausedCount });
    return pausedCount;
  }

  /**
   * Release deferred-event locks held by non-alive instances.
   */
  public async releaseOrphanedDeferredEvents(
    cid: string = getCorrelationIdentifier(),
  ): Promise<number> {
    const trace = (args: Record<string, any>) =>
      this.trace({ cid, in: 'releaseOrphanedDeferredEvents', ...args });

    const releasedCount = await this.releaseDeferredEventsWithoutLiveOwner();

    if (releasedCount > 0) {
      trace({ message: 'Released orphaned deferred events', releasedCount });
    }

    return releasedCount;
  }

  public async removeInstance(instanceId: string, cid: string): Promise<void> {
    const trace = (args: Record<string, any>) =>
      this.trace({ cid, in: 'removeInstance', ...args });

    // Deregister this instance so it stops counting as alive. Marking it dying
    // (rather than deleting the row) keeps it consistent with the death-note
    // model and lets countAliveInstances exclude it for free. The row is reaped
    // later by reapDeadInstances on a subsequent startup.
    await this.markInstanceDying(instanceId);

    trace({ message: 'Done' });
  }

  public async getPausedChartCount(cid: string): Promise<number> {
    const trace = (args: Record<string, any>) =>
      this.trace({ cid, in: 'getPausedChartCount', ...args });

    trace({ message: 'Counting paused charts' });
    const pausedChartCount = await this.countPausedCharts();
    trace({ message: 'Counted paused charts', pausedChartCount });

    return pausedChartCount;
  }

  /**
   * @param instanceId
   * @param cid
   * @returns Chart id list for the adopted charts
   */
  public async gentlyAdoptCharts(
    instanceId: string,
    cid: string,
  ): Promise<ChartReference[]> {
    const trace = (args: Record<string, any>) =>
      this.trace({ cid, in: 'gentlyAdoptCharts', id: instanceId, ...args });

    trace({ message: 'Gently adopt all idle charts' });

    // Claim each candidate atomically: with several live instances reconciling
    // concurrently, exactly one claimant wins each chart.
    const candidateChartIds =
      await this.getPausedChartWithNoOngoingActivitiesIds();

    const adoptedChartIds: ChartReference[] = [];
    for (const ref of candidateChartIds) {
      if (await this.claimPausedChart(instanceId, ref, true)) {
        adoptedChartIds.push(ref);
      }
    }

    trace({ message: 'Done' });
    return adoptedChartIds;
  }

  /**
   * @param instanceId
   * @param cid
   */
  public async forciblyAdoptCharts(
    instanceId: string,
    cid: string,
  ): Promise<ChartReference[]> {
    const trace = (args: Record<string, any>) =>
      this.trace({ cid, in: 'forciblyAdoptCharts', ...args });

    trace({ message: 'Forcibly adopt all foreign charts' });

    // Claim each paused chart atomically regardless of ongoing activities.
    // The previous owner is gone, so its activity rows are stale — delete
    // them per adopted chart (only for charts this instance actually won).
    const candidateChartIds = await this.getPausedChartIds();

    const adoptedChartIds: ChartReference[] = [];
    for (const ref of candidateChartIds) {
      if (await this.claimPausedChart(instanceId, ref, false)) {
        await this.deleteOngoingActivitiesForChart(ref);
        adoptedChartIds.push(ref);
      }
    }

    trace({ message: 'Done' });
    return adoptedChartIds;
  }

  /**
   * @param instanceId
   * @param ref
   * @param state
   * @param parentRef
   * @param cid
   */
  public async createChart<
    TContext,
    TEvent extends EventObject,
    TStateSchema extends StateSchema<any>,
    TTypeState extends Typestate<any>,
  >(
    instanceId: string,
    ref: ChartReference,
    state: State<TContext, TEvent, TStateSchema, TTypeState>,
    parentRef: ChartReference | null = null,
    cid = getCorrelationIdentifier(),
  ): Promise<void> {
    const trace = (args: Record<string, any>) =>
      this.trace({ cid, in: 'createChart', ...args });

    trace({ message: 'Writing state to the database' });
    await this.insertChart(instanceId, ref, parentRef, state);

    trace({ message: 'Done' });
  }

  public async isChartPresent(
    ref: ChartReference,
    connection?: ConnectionType,
  ) {
    return await this.chartExists(ref, connection);
  }

  /**
   * @param ref
   * @param cid
   * @param connection
   */
  public async loadChart<
    TContext,
    TEvent extends EventObject,
    TStateSchema extends StateSchema,
    TTypeState extends Typestate<TContext>,
  >(
    ref: ChartReference,
    cid = getCorrelationIdentifier(),
    connection?: ConnectionType,
  ): Promise<{
    state: State<TContext, TEvent, TStateSchema, TTypeState>;
    ref: ChartReference;
    parentRef: ChartReference | null;
  } | null> {
    const trace = (args: Record<string, any>) =>
      this.trace({ cid, in: 'loadChart', ref, ...args });

    trace({ message: 'Reading chart from the database' });
    const chartRow = await this.readChart<TContext, TEvent>(ref, connection);

    if (!chartRow) {
      trace({ level: 'warning', message: 'Chart not found in the database' });
      return null;
    }

    trace({ message: 'Creating state object' });
    const state = State.create<TContext, TEvent>(chartRow.state);

    trace({ message: 'Done' });

    return {
      ref: chartRow.ref,
      parentRef: chartRow.parentRef,
      state: state as unknown as State<
        TContext,
        TEvent,
        TStateSchema,
        TTypeState
      >,
    };
  }

  /**
   * @param ref
   * @param state
   * @param cid
   * @param connection
   */
  public async updateChart<TContext, TEvent extends EventObject>(
    ref: ChartReference,
    state: State<TContext, TEvent, any, any>,
    cid = getCorrelationIdentifier(),
    connection?: ConnectionType,
    expectedOwnerId?: string,
  ): Promise<void> {
    const trace = (args: Record<string, any>) =>
      this.trace({ cid, in: 'updateChart', ref, ...args });

    trace({ message: 'Storing the chart to the database' });
    const updatedRowCount = await this.updateChartState(
      ref,
      state,
      expectedOwnerId ?? null,
      connection,
    );

    if (expectedOwnerId !== undefined && updatedRowCount === 0) {
      throw new ChartOwnershipLostError(ref, expectedOwnerId);
    }

    trace({ message: 'Done' });
  }

  /**
   * @param ref
   * @param cid
   */
  public async destroyChart(
    ref: ChartReference,
    cid = getCorrelationIdentifier(),
  ): Promise<void> {
    const trace = (args: Record<string, any>) =>
      this.trace({ cid, in: 'destroyChart', ref, ...args });

    await this.withTransaction(async (connection) => {
      trace({ message: 'Removing chart from the database' });
      const deletedChartRecords = await this.deleteChart(ref, connection);

      if (deletedChartRecords < 1) {
        trace({ level: 'warning', message: 'Chart not found in the database' });
        return;
      } else if (deletedChartRecords === 1) {
        trace({ message: 'Removed chart from the database' });
      } else {
        trace({
          level: 'warning',
          message: 'Removed multiple charts from the database',
          deletedRecords: deletedChartRecords,
        });
      }

      trace({ message: 'Removing deferred events from the database' });
      const deletedDeferredEventRecords = await this.deleteAllDeferredEvents(
        ref,
        connection,
      );
      trace({
        message: 'Removed deferred events from the database',
        deletedRecords: deletedDeferredEventRecords,
      });

      trace({ message: 'Removing external identifiers from the database' });
      const deletedExternalIdentifierRecords =
        await this.deleteExternalIdentifiers(ref, connection);
      trace({
        message: 'Removed external identifiers from the database',
        deletedRecords: deletedExternalIdentifierRecords,
      });
    });

    trace({ message: 'Done' });
  }

  /**
   * @param deferredEventRow
   * @param cid
   */
  public async deferEvent<TContext, TEvent extends EventObject>(
    deferredEventRow: Omit<
      PersistedDeferredEvent,
      'id' | 'eventId' | 'due' | 'timestamp'
    > & { eventId?: number | string },
    cid = getCorrelationIdentifier(),
  ): Promise<PersistedDeferredEvent> {
    const trace = (args: Record<string, any>) =>
      this.trace({
        cid,
        in: 'deferEvent',
        ref: deferredEventRow.ref,
        eventId: deferredEventRow.eventId,
        lock: deferredEventRow.lock,
        ...args,
      });

    return await this.withTransaction(async (connection) => {
      const timestamp = Date.now();
      const due = timestamp + Math.ceil(deferredEventRow.delay);

      trace({
        message: 'Inserting deferred event into the database',
        delay: deferredEventRow.delay,
        timestamp,
        due,
      });

      const insertedEventRow = await this.insertDeferredEvent(
        {
          ref: deferredEventRow.ref,
          eventId: deferredEventRow.eventId ?? randomUUID(),
          eventTo: deferredEventRow.eventTo ?? null,
          event: deferredEventRow.event,
          timestamp,
          delay: deferredEventRow.delay,
          due,
          lock: deferredEventRow.lock,
        },
        connection,
      );

      if (!insertedEventRow) {
        throw new Error(
          `Failed to insert deferred event ${deferredEventRow.eventId}`,
        );
      }

      trace({ message: 'Done' });
      return insertedEventRow;
    });
  }

  public async isDeferredEventPresent(
    ref: ChartReference,
    eventId: string | number,
    connection?: ConnectionType,
  ): Promise<boolean> {
    return (
      (await this.readDeferredEventByEventId(ref, eventId, connection)) !== null
    );
  }

  /**
   * @param cid
   */
  public async releaseAllDeferredEvents(
    cid = getCorrelationIdentifier(),
  ): Promise<void> {
    const trace = (args: Record<string, any>) =>
      this.trace({ cid, in: 'releaseAllDeferredEvents', ...args });

    trace({ message: 'Releasing deferred events' });
    await this.unmarkAllDeferredEventsForProcessing();

    trace({ message: 'Done' });
  }

  /**
   * @param instanceId
   * @param lookAhead
   * @param batchSize
   * @param cid
   */
  public async takeUpcomingDeferredEvents(
    instanceId: string,
    lookAhead: number,
    batchSize: number,
    cid = getCorrelationIdentifier(),
  ): Promise<PersistedDeferredEvent[]> {
    const trace = (args: Record<string, any>) =>
      this.trace({ cid, in: 'takeUpcomingDeferredEvents', ...args });

    trace({
      message: 'Reading upcoming events from the database',
      batchSize,
      lookAhead,
    });

    trace({ message: 'Taking upcoming events' });
    const deferredEvents = await this.readDeferredEventRowBatch(
      instanceId,
      lookAhead,
      batchSize,
    );

    trace({ message: 'Done', count: deferredEvents.length });
    return deferredEvents;
  }

  /**
   * @param deferredEventRow
   * @param cid
   */
  public async removeDeferredEvent(
    deferredEventRow: PersistedDeferredEvent,
    cid = getCorrelationIdentifier(),
  ): Promise<void> {
    const trace = (args: Record<string, any>) =>
      this.trace({
        cid,
        in: 'removeDeferredEvent',
        ref: deferredEventRow.ref,
        id: deferredEventRow.id,
        ...args,
      });

    trace({ message: 'Removing deferred event from the database' });
    await this.deleteDeferredEvent(deferredEventRow.id);

    trace({ message: 'Done' });
  }
}
