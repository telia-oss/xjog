import {
  PersistedChart,
  PersistedDeferredEvent,
  PersistenceAdapter,
} from '../../packages/core-persistence/src';
import {
  ActivityRef,
  ChartReference,
  referencesMatch,
} from '../../packages/util/src';

type PersistedInstance = {
  timestamp: number;
  instanceId: string;
  dying: boolean;
};

type PersistedExternalId = {
  key: string;
  value: string;
  ref: ChartReference;
};

type PersistedOngoingActivity = {
  timestamp: number;
  machineId: string;
  chartId: string;
  activityId: string;
};

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function serializeState(state: any): any {
  return JSON.parse(JSON.stringify(state));
}

function cloneRef(ref: ChartReference): ChartReference {
  return { ...ref };
}

function chartKey(ref: ChartReference): string {
  return `${ref.machineId}::${ref.chartId}`;
}

export class MockPersistenceAdapter extends PersistenceAdapter<void> {
  public readonly component = 'persistence/mock';
  public readonly type = 'mock';

  public readonly instances = {
    rows: [] as PersistedInstance[],
  };

  public readonly charts = {
    rows: [] as PersistedChart<any, any>[],
  };

  public readonly deferredEvents = {
    rows: [] as PersistedDeferredEvent[],
  };

  public readonly ongoingActivities = {
    rows: [] as PersistedOngoingActivity[],
  };

  public readonly externalIds = {
    rows: [] as PersistedExternalId[],
  };

  private nextDeferredEventId = 1;

  private deathNoteListeners = new Map<string, Set<() => void>>();

  public async withTransaction<ReturnType>(
    routine: () => Promise<ReturnType> | ReturnType,
  ): Promise<ReturnType> {
    return await routine();
  }

  public async countAliveInstances(): Promise<number> {
    return this.instances.rows.filter((row) => !row.dying).length;
  }

  protected async insertInstance(id: string): Promise<void> {
    this.instances.rows = this.instances.rows.filter(
      (row) => row.instanceId !== id,
    );
    this.instances.rows.push({
      timestamp: Date.now(),
      instanceId: id,
      dying: false,
    });
  }

  protected async deleteInstance(id: string): Promise<void> {
    this.instances.rows = this.instances.rows.filter(
      (row) => row.instanceId !== id,
    );
    this.deathNoteListeners.delete(id);
  }

  protected async markAllInstancesDying(): Promise<void> {
    for (const row of this.instances.rows) {
      row.dying = true;
    }
  }

  public onDeathNote(instanceId: string, callback: () => void): () => void {
    const listeners = this.deathNoteListeners.get(instanceId) ?? new Set();
    listeners.add(callback);
    this.deathNoteListeners.set(instanceId, listeners);

    return () => {
      const current = this.deathNoteListeners.get(instanceId);
      current?.delete(callback);
      if (!current?.size) {
        this.deathNoteListeners.delete(instanceId);
      }
    };
  }

  public override async overthrowOtherInstances(
    instanceId: string,
    cid: string,
  ): Promise<void> {
    const doomedInstanceIds = this.instances.rows
      .filter((row) => !row.dying && row.instanceId !== instanceId)
      .map((row) => row.instanceId);

    await super.overthrowOtherInstances(instanceId, cid);

    for (const doomedInstanceId of doomedInstanceIds) {
      const listeners = [
        ...(this.deathNoteListeners.get(doomedInstanceId) ?? []),
      ];
      for (const listener of listeners) {
        queueMicrotask(listener);
      }
    }
  }

  protected async insertChart(
    instanceId: string,
    ref: ChartReference,
    parentRef: ChartReference | null,
    state: any,
  ): Promise<void> {
    this.charts.rows.push({
      timestamp: Date.now(),
      ownerId: instanceId,
      ref: cloneRef(ref),
      parentRef: parentRef ? cloneRef(parentRef) : null,
      state: serializeState(state),
      paused: false,
    });
  }

  protected async chartExists(ref: ChartReference): Promise<boolean> {
    return this.charts.rows.some((row) => referencesMatch(row.ref, ref));
  }

  protected async readChart<TContext, TEvent extends { type: string }>(
    ref: ChartReference,
  ): Promise<PersistedChart<TContext, TEvent> | null> {
    const row = this.charts.rows.find((candidate) =>
      referencesMatch(candidate.ref, ref),
    );

    if (!row) {
      return null;
    }

    return {
      ...row,
      ref: cloneRef(row.ref),
      parentRef: row.parentRef ? cloneRef(row.parentRef) : null,
      state: serializeState(row.state),
    } as PersistedChart<TContext, TEvent>;
  }

  protected async updateChartState(
    ref: ChartReference,
    serializedState: any,
  ): Promise<void> {
    const row = this.charts.rows.find((candidate) =>
      referencesMatch(candidate.ref, ref),
    );

    if (!row) {
      throw new Error(`Chart ${chartKey(ref)} not found`);
    }

    row.timestamp = Date.now();
    row.state = serializeState(serializedState);
  }

  protected async markAllChartsPaused(): Promise<void> {
    for (const row of this.charts.rows) {
      row.paused = true;
    }
  }

  protected async countPausedCharts(): Promise<number> {
    return this.charts.rows.filter((row) => row.paused).length;
  }

  protected async getPausedChartIds(): Promise<ChartReference[]> {
    return this.charts.rows
      .filter((row) => row.paused)
      .map((row) => cloneRef(row.ref));
  }

  protected async getPausedChartWithNoOngoingActivitiesIds(): Promise<
    ChartReference[]
  > {
    return this.charts.rows
      .filter((row) => row.paused)
      .filter(
        (row) =>
          !this.ongoingActivities.rows.some((activity) =>
            referencesMatch(row.ref, {
              machineId: activity.machineId,
              chartId: activity.chartId,
            }),
          ),
      )
      .map((row) => cloneRef(row.ref));
  }

  public async countOwnCharts(instanceId: string): Promise<number> {
    return this.charts.rows.filter((row) => row.ownerId === instanceId).length;
  }

  protected async deleteOngoingActivitiesForPausedCharts(): Promise<number> {
    const pausedKeys = new Set(
      this.charts.rows
        .filter((row) => row.paused)
        .map((row) => chartKey(row.ref)),
    );

    const before = this.ongoingActivities.rows.length;
    this.ongoingActivities.rows = this.ongoingActivities.rows.filter(
      (row) =>
        !pausedKeys.has(
          chartKey({ machineId: row.machineId, chartId: row.chartId }),
        ),
    );
    return before - this.ongoingActivities.rows.length;
  }

  protected async changeOwnerAndResumePausedCharts(id: string): Promise<void> {
    for (const row of this.charts.rows) {
      if (row.paused) {
        row.ownerId = id;
        row.paused = false;
      }
    }
  }

  protected async changeOwnerAndResumeCharts(
    instanceId: string,
    refs: ChartReference[],
  ): Promise<void> {
    const refKeys = new Set(refs.map(chartKey));
    for (const row of this.charts.rows) {
      if (refKeys.has(chartKey(row.ref))) {
        row.ownerId = instanceId;
        row.paused = false;
      }
    }
  }

  protected async deleteChart(ref: ChartReference): Promise<number> {
    const before = this.charts.rows.length;
    this.charts.rows = this.charts.rows.filter(
      (row) => !referencesMatch(row.ref, ref),
    );
    return before - this.charts.rows.length;
  }

  public async isActivityRegistered(
    ref: ChartReference,
    activityId: string,
  ): Promise<boolean> {
    return this.ongoingActivities.rows.some(
      (row) =>
        row.activityId === activityId &&
        referencesMatch(ref, {
          machineId: row.machineId,
          chartId: row.chartId,
        }),
    );
  }

  public async registerActivity(
    ref: ChartReference,
    activityId: string,
  ): Promise<void> {
    if (await this.isActivityRegistered(ref, activityId)) {
      return;
    }

    this.ongoingActivities.rows.push({
      timestamp: Date.now(),
      machineId: ref.machineId,
      chartId: ref.chartId,
      activityId,
    });
  }

  public async unregisterActivity(
    ref: ChartReference,
    activityId: string,
  ): Promise<void> {
    this.ongoingActivities.rows = this.ongoingActivities.rows.filter(
      (row) =>
        row.activityId !== activityId ||
        !referencesMatch(ref, {
          machineId: row.machineId,
          chartId: row.chartId,
        }),
    );
  }

  protected async insertDeferredEvent(
    deferredEventRow: Omit<PersistedDeferredEvent, 'id'>,
  ): Promise<PersistedDeferredEvent | null> {
    const row: PersistedDeferredEvent = {
      ...cloneValue(deferredEventRow),
      ref: cloneRef(deferredEventRow.ref),
      id: this.nextDeferredEventId++,
    };
    this.deferredEvents.rows.push(row);
    return cloneValue(row);
  }

  protected async readDeferredEventRow(
    id: number,
  ): Promise<PersistedDeferredEvent | null> {
    const row = this.deferredEvents.rows.find(
      (candidate) => candidate.id === id,
    );
    return row ? cloneValue(row) : null;
  }

  protected async readDeferredEventByEventId(
    ref: ChartReference,
    eventId: string | number,
  ): Promise<PersistedDeferredEvent | null> {
    const row = this.deferredEvents.rows.find(
      (candidate) =>
        candidate.eventId === eventId && referencesMatch(candidate.ref, ref),
    );
    return row ? cloneValue(row) : null;
  }

  protected async readDeferredEventRowBatch(
    instanceId: string,
    lookAhead: number,
    batchSize: number,
  ): Promise<PersistedDeferredEvent[]> {
    const latestDue = Date.now() + lookAhead;
    const rows = this.deferredEvents.rows
      .filter((row) => row.lock === null)
      .filter((row) => row.due <= latestDue)
      .sort((a, b) => a.due - b.due || a.id - b.id)
      .slice(0, batchSize);

    for (const row of rows) {
      row.lock = instanceId;
    }

    return rows.map((row) => cloneValue(row));
  }

  public async releaseDeferredEvent(
    ref: ChartReference,
    eventId: number,
  ): Promise<void> {
    const row = this.deferredEvents.rows.find(
      (candidate) =>
        candidate.id === eventId && referencesMatch(candidate.ref, ref),
    );
    if (row) {
      row.lock = null;
    }
  }

  protected async unmarkAllDeferredEventsForProcessing(): Promise<void> {
    for (const row of this.deferredEvents.rows) {
      row.lock = null;
    }
  }

  protected async deleteDeferredEvent(id: number): Promise<number> {
    const before = this.deferredEvents.rows.length;
    this.deferredEvents.rows = this.deferredEvents.rows.filter(
      (row) => row.id !== id,
    );
    return before - this.deferredEvents.rows.length;
  }

  protected async deleteAllDeferredEvents(
    ref: ChartReference,
  ): Promise<number> {
    const before = this.deferredEvents.rows.length;
    this.deferredEvents.rows = this.deferredEvents.rows.filter(
      (row) => !referencesMatch(row.ref, ref),
    );
    return before - this.deferredEvents.rows.length;
  }

  public async getExternalIdentifiers(
    key: string,
    ref: ChartReference,
  ): Promise<string[]> {
    return this.externalIds.rows
      .filter((row) => row.key === key && referencesMatch(row.ref, ref))
      .map((row) => row.value);
  }

  public async registerExternalId(
    ref: ChartReference,
    key: string,
    value: string,
  ): Promise<void> {
    if (
      this.externalIds.rows.some(
        (row) =>
          row.key === key &&
          row.value === value &&
          referencesMatch(row.ref, ref),
      )
    ) {
      return;
    }

    this.externalIds.rows.push({ key, value, ref: cloneRef(ref) });
  }

  public async dropExternalId(key: string, value: string): Promise<number> {
    const before = this.externalIds.rows.length;
    this.externalIds.rows = this.externalIds.rows.filter(
      (row) => row.key !== key || row.value !== value,
    );
    return before - this.externalIds.rows.length;
  }

  public async getChartByExternalIdentifier(
    key: string,
    value: string,
  ): Promise<ChartReference | null> {
    const row = this.externalIds.rows.find(
      (candidate) => candidate.key === key && candidate.value === value,
    );
    return row ? cloneRef(row.ref) : null;
  }

  protected async deleteExternalIdentifiers(
    ref: ChartReference,
  ): Promise<number> {
    const before = this.externalIds.rows.length;
    this.externalIds.rows = this.externalIds.rows.filter(
      (row) => !referencesMatch(row.ref, ref),
    );
    return before - this.externalIds.rows.length;
  }
}
