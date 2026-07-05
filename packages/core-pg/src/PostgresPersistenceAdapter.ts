import path from 'node:path';
import { AbstractPostgresPersistenceAdapter } from '@telia-oss/xjog-core-persistence';
import migrationRunner from 'node-pg-migrate';
import {
  type ClientConfig,
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from 'pg';

/**
 * Options for instantiating {@link PostgresPersistenceAdapter}.
 */
export type PostgreSQLPersistenceAdapterOptions = Record<string, never>;

/**
 * Use the static method [connect]{@link PostgresPersistenceAdapter.connect} to
 * create an instance of this {@link PersistenceAdapter PersistenceAdapter} for
 * [PostgreSql](https://www.postgresql.org/).
 *
 * @group Persistence
 * @extends PersistenceAdapter
 * @hideconstructor
 */
export class PostgresPersistenceAdapter extends AbstractPostgresPersistenceAdapter<
  Pool | PoolClient
> {
  public readonly component = 'persistence';
  public readonly type = 'pg';

  public constructor(
    public readonly pool: Pool,
    public readonly clientConfig: ClientConfig,
  ) {
    super();
  }

  /**
   * Create a connection to a [PostgreSql](https://www.postgresql.org/) database
   * and resolve to an PersistenceAdapter that can be passed to the XJog
   * constructor.
   *
   * **Warning:** Don't run multiple `connect`s on same database at the same time,
   * since this will cause trouble with the schema migrations, be that journal or
   * regular database adapter. Let one resolve (e.g. `await`) before calling another.
   */
  static async connect(
    poolConfiguration: PoolConfig,
    // TODO resolve
    options: Partial<PostgreSQLPersistenceAdapterOptions> = {},
  ): Promise<PostgresPersistenceAdapter> {
    // TODO pass logging to the pool
    const pool = new Pool(poolConfiguration);
    const adapter = new PostgresPersistenceAdapter(pool, poolConfiguration);
    pool.on('error', (err) => adapter.error('Pool emitted error', { err }));

    let migrationClient;
    try {
      migrationClient = await pool.connect();
      await migrationRunner({
        dbClient: migrationClient,
        migrationsTable: 'migrations_xjog',
        dir: path.join(__dirname, './migrations'),
        direction: 'up',
        log: (message) => adapter.trace({ in: 'connect', message }),
        // https://github.com/salsita/node-pg-migrate/issues/821,
        checkOrder: false,
        noLock: true,
      });
    } finally {
      if (migrationClient) {
        await migrationClient.release();
      }
    }

    return adapter;
  }

  public async disconnect(): Promise<void> {
    await this.pool.end();
  }

  /**
   * @group Transactions
   *
   * Executes the routine within a transaction. In case of an error,
   * rolls back. Otherwise, commits at the end. Inside, use the client,
   * if applicable.
   */
  public async withTransaction<ReturnType>(
    routine: (client: PoolClient) => Promise<ReturnType> | ReturnType,
    transactionConnectionForNesting?: PoolClient,
  ): Promise<ReturnType> {
    const client = await this.pool.connect();
    await client.query('BEGIN');

    try {
      const returnValue = await routine(client);
      await client.query('COMMIT');
      return returnValue;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  protected async runQuery<T>(
    connection: Pool | PoolClient = this.pool,
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const result = await connection.query<QueryResultRow>(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  // TODO use listening instead, slicker
  public onDeathNote(
    instanceId: string,
    callback: () => void,
    connection: Pool | PoolClient = this.pool,
  ): () => void {
    let cancelled = false;

    let timer: ReturnType<typeof setInterval> | null = setInterval(async () => {
      if (cancelled) {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        return;
      }

      const result = await connection.query<{ dying: number }>(
        'SELECT COUNT(*) as "dying" FROM "instances" ' +
          'WHERE "instanceId" = $1 AND "dying" = TRUE',
        [instanceId],
      );

      // Re-check after the await: cancel() may have run meanwhile, or a
      // parallel in-flight poll may already have delivered the note.
      if (cancelled) {
        return;
      }

      const dying = Number(result.rows[0].dying) > 0;

      if (dying) {
        cancelled = true;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        callback();
      }
    }, 500);

    return () => {
      cancelled = true;
      if (timer) {
        clearInterval(timer);
      }
    };
  }
}
