import path from 'node:path';
import { AbstractPostgresDigestPersistenceAdapter } from '@telia-oss/xjog-digest-persistence';
import type { ChartReference } from '@telia-oss/xjog-util';
import migrationRunner from 'node-pg-migrate';
import { Client, Pool, type PoolConfig, type QueryResultRow } from 'pg';
import createSubscriber from 'pg-listen';

/**
 * Use the static method `connect` to instantiate.
 * @hideconstructor
 */
export class PostgresDigestPersistenceAdapter extends AbstractPostgresDigestPersistenceAdapter {
  public readonly component = 'digest/persistence';
  public readonly type = 'pg';

  protected readonly newDigestEntryChannel = 'new-digest-entry';

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
    // Verify the pool can actually establish a connection before returning,
    // but release it immediately: an unreleased client here permanently
    // occupies a pool slot and causes pool.end() (called from disconnect())
    // to hang forever, since the pool waits for every checked-out client to
    // be released before it can close.
    (await pool.connect()).release();

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

  protected async runQuery<T>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const result = await this.pool.query<QueryResultRow>(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  private async startObservingNewDigestEntries(): Promise<() => Promise<void>> {
    const channel = this.newDigestEntryChannel;
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
}
