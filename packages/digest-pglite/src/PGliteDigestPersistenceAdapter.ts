import path from 'node:path';
import { PGlite, type PGliteOptions } from '@electric-sql/pglite';
import { AbstractPostgresDigestPersistenceAdapter } from '@telia-oss/xjog-digest-persistence';
import type { ChartReference } from '@telia-oss/xjog-util';
import migrationRunner from 'node-pg-migrate';

/**
 * Use the static method `connect` to instantiate.
 * @hideconstructor
 */
export class PGliteDigestPersistenceAdapter extends AbstractPostgresDigestPersistenceAdapter {
  public readonly component = 'digest/persistence';
  public readonly type = 'pglite';

  protected readonly newDigestEntryChannel = 'new_digest_entry';

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

  protected async runQuery<T>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const result = await this.pool.query<T>(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
  }

  private async startObservingNewDigestEntries(): Promise<() => Promise<void>> {
    const channel = this.newDigestEntryChannel;

    this.pool.listen(channel, (payload: string) => {
      this.newDigestEntriesSubject.next(JSON.parse(payload) as ChartReference);
    });

    return async () => {
      await this.pool.unlisten(channel);
    };
  }
}
