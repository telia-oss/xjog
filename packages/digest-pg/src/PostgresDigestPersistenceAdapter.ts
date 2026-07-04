import path from 'node:path';
import {
  type ChartReferenceWithTimestamp,
  type DigestEntries,
  type DigestEntry,
  DigestPersistenceAdapter,
  type DigestQuery,
  filterQuery,
} from '@telia-oss/xjog-digest-persistence';
import type { ChartReference } from '@telia-oss/xjog-util';
import migrationRunner from 'node-pg-migrate';
import { Client, Pool, type PoolConfig } from 'pg';
import bind from 'pg-bind';
import createSubscriber from 'pg-listen';

import type { PostgresDigestRow } from './PostgresDigestRow';

/**
 * Use the static method `connect` to instantiate.
 * @hideconstructor
 */
export class PostgresDigestPersistenceAdapter extends DigestPersistenceAdapter {
  public readonly component = 'digest/persistence';
  public readonly type = 'pg';

  private readonly stopObservingNewDigestEntries: Promise<() => Promise<void>>;

  public constructor(
    private readonly listenerConfig: PoolConfig,
    private readonly pool: Pool,
  ) {
    super();

    pool.on('error', (err) =>
      this.error('Subscription connection emitted error', { err }),
    );

    this.stopObservingNewDigestEntries = this.startObservingNewDigestEntries();
  }

  /**
   * Create a connection to a [PostgreSql](https://www.postgresql.org/) database
   * and resolve to a JournalPersistenceAdapter that can be passed to the XJog
   * constructor.
   */
  static async connect(
    poolConfiguration: PoolConfig,
  ): Promise<PostgresDigestPersistenceAdapter> {
    const pool = new Pool(poolConfiguration);
    await pool.connect();

    const adapter = new PostgresDigestPersistenceAdapter(
      poolConfiguration,
      pool,
    );

    const migrationClient = new Client(poolConfiguration);
    try {
      await migrationClient.connect();
      await migrationRunner({
        dbClient: migrationClient,
        migrationsTable: 'migrations_digest',
        dir: path.join(__dirname, './migrations'),
        direction: 'up',
        log: (message) => adapter.trace({ in: 'connect', message }),
        // https://github.com/salsita/node-pg-migrate/issues/821
        checkOrder: false,
        noLock: true,
      });
    } finally {
      if (migrationClient) {
        await migrationClient.end();
      }
    }

    return adapter;
  }

  public async disconnect(): Promise<void> {
    await (await this.stopObservingNewDigestEntries)?.();
    await this.pool.end();
  }

  protected async upsertDigest(
    ref: ChartReference,
    key: string,
    value: string,
  ): Promise<number> {
    const result = await this.pool.query(
      bind(
        'INSERT INTO "digests" ' +
          '( ' +
          '  "machineId", "chartId", "key", "value" ' +
          ') VALUES ( ' +
          '  :machineId, :chartId, :key, :value' +
          ') ON CONFLICT ( ' +
          '  "machineId", "chartId", "key"' +
          ') DO UPDATE SET ' +
          '  value = :value, timestamp = transaction_timestamp() ',
        {
          machineId: ref.machineId,
          chartId: ref.chartId,
          key,
          value,
        },
      ),
    );

    return result.rowCount;
  }

  protected async emitDigestEntryNotification(
    ref: ChartReference,
  ): Promise<void> {
    const payload = JSON.stringify(ref);

    await this.pool.query(
      bind("SELECT pg_notify('new-digest-entry', :payload::text)", {
        payload,
      }),
    );
  }

  public async deleteDigest(ref: ChartReference, key: string): Promise<number> {
    const result = await this.pool.query(
      bind(
        'DELETE FROM "digests" ' +
          'WHERE "machineId" = :machineId AND "chartId" = :chartId AND "key" = :key ',
        {
          machineId: ref.machineId,
          chartId: ref.chartId,
          key,
        },
      ),
    );

    return result.rowCount;
  }

  public async deleteByChart(ref: ChartReference): Promise<number> {
    const result = await this.pool.query(
      bind(
        'DELETE FROM "digests" ' +
          'WHERE "machineId" = :machineId AND "chartId" = :chartId ',
        {
          machineId: ref.machineId,
          chartId: ref.chartId,
        },
      ),
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
    const result = await this.pool.query<PostgresDigestRow>(
      bind(
        'SELECT ' +
          this.digestEntrySqlSelectFields +
          'FROM "digests" ' +
          'WHERE "machineId" = :machineId AND "chartId" = :chartId AND key = :key ',
        {
          machineId: ref.machineId,
          chartId: ref.chartId,
          key,
        },
      ),
    );

    if (!result.rowCount) {
      return null;
    }

    return PostgresDigestPersistenceAdapter.parseSqlDigestRow(result.rows[0]);
  }

  public async readByChart(ref: ChartReference): Promise<DigestEntries> {
    const result = await this.pool.query<PostgresDigestRow>(
      bind(
        'SELECT ' +
          this.digestEntrySqlSelectFields +
          'FROM "digests" ' +
          'WHERE "machineId" = :machineId AND "chartId" = :chartId ',
        {
          machineId: ref.machineId,
          chartId: ref.chartId,
        },
      ),
    );

    const digestEntries: DigestEntries = {};

    for (const row of result.rows) {
      digestEntries[row.key] =
        PostgresDigestPersistenceAdapter.parseSqlDigestRow(row);
    }

    return digestEntries;
  }

  public async queryDigests(
    digestQuery?: DigestQuery,
  ): Promise<ChartReferenceWithTimestamp[]> {
    const [filterQueryString, filterBindings] = filterQuery(digestQuery?.query);

    const boundSql = bind(
      'SELECT DISTINCT "machineId", "chartId", ' +
        '  MAX(extract(epoch from "timestamp") * 1000) as "timestamp" ' +
        'FROM "digests" WHERE TRUE ' +
        (digestQuery?.machineId !== undefined
          ? '  AND "machineId" = :machineId '
          : '') +
        (digestQuery?.chartId !== undefined
          ? '  AND "chartId" = :chartId '
          : '') +
        (filterQueryString ? `AND (${filterQueryString}) ` : '') +
        'GROUP BY "machineId", "chartId" ' +
        'ORDER BY "timestamp" ' +
        (digestQuery?.order ?? 'ASC') +
        (digestQuery?.offset !== undefined ? '  OFFSET :offset' : '') +
        (digestQuery?.limit !== undefined ? '  LIMIT :limit' : ''),
      {
        machineId: digestQuery?.machineId,
        chartId: digestQuery?.chartId,
        offset: digestQuery?.offset,
        limit: digestQuery?.limit,
        ...filterBindings,
      },
    );

    const result = await this.pool.query<ChartReferenceWithTimestamp>(boundSql);

    return result.rows;
  }

  private async startObservingNewDigestEntries(): Promise<() => Promise<void>> {
    const channel = 'new-digest-entry';
    const digestSubscriber = createSubscriber(this.listenerConfig);

    // Received a notification of a new journal entry
    digestSubscriber.notifications.on(channel, async (ref: ChartReference) => {
      this.newDigestEntriesSubject.next(ref);
    });

    digestSubscriber.events.on('error', (error) => {
      this.newDigestEntriesSubject.error(error);
    });

    digestSubscriber
      .connect()
      .then(() => digestSubscriber.listenTo(channel))
      .catch((err) =>
        this.error('Failed to connect digest subscriber', { err }),
      );

    return async () => {
      await digestSubscriber.close();
    };
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
