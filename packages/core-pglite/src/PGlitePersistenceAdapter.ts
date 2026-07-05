export type { PGlite, PGliteOptions, Transaction } from '@electric-sql/pglite';

import path from 'node:path';
import {
  PGlite,
  type PGliteOptions,
  type Transaction,
} from '@electric-sql/pglite';
import { AbstractPostgresPersistenceAdapter } from '@telia-oss/xjog-core-persistence';
import migrationRunner from 'node-pg-migrate';

/**
 * Options for instantiating {@link PGlitePersistenceAdapter}.
 */
export type PGlitePersistenceAdapterOptions = Record<string, never>;

/**
 * Use the static method [connect]{@link PGlitePersistenceAdapter.connect} to
 * create an instance of this {@link PersistenceAdapter PersistenceAdapter} for
 * [Pglite](https://github.com/electric-sql/pglite).
 *
 * @group Persistence
 * @extends PersistenceAdapter
 * @hideconstructor
 */
export class PGlitePersistenceAdapter extends AbstractPostgresPersistenceAdapter<PGlite> {
  public readonly component = 'persistence';
  public readonly type = 'pglite';

  public constructor(
    public readonly pool: PGlite,
    public readonly clientConfig: PGliteOptions,
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
    poolConfiguration: PGliteOptions = {},
    options: Partial<PGlitePersistenceAdapterOptions> = {},
  ): Promise<PGlitePersistenceAdapter> {
    // TODO pass logging to the pool
    const pool = await PGlite.create(poolConfiguration);
    const adapter = new PGlitePersistenceAdapter(pool, poolConfiguration);

    try {
      // NOTE: Pglite does not allow running multiple queries with query but exec should be used
      // and migration runner uses query.
      await migrationRunner({
        dbClient: pool as any,
        migrationsTable: 'migrations_xjog',
        singleTransaction: true,
        dir: path.join(__dirname, 'migrations'),
        direction: 'up',
        log: (message) => adapter.trace({ in: 'connect', message }),
        // https://github.com/salsita/node-pg-migrate/issues/821,
        checkOrder: false,
        noLock: false,
      });
    } catch (error) {
      await pool.close();
      throw error;
    }

    return adapter;
  }

  public async disconnect(): Promise<void> {
    await this.pool.close();
  }

  /**
   * @group Transactions
   *
   * Executes the routine within a transaction. In case of an error,
   * rolls back. Otherwise, commits at the end. Inside, use the client,
   * if applicable.
   */
  public async withTransaction<ReturnType>(
    routine: (client: PGlite) => Promise<ReturnType> | ReturnType,
    transactionConnectionForNesting?: Transaction,
  ): Promise<ReturnType> {
    return await this.pool.transaction(async (tx: Transaction) => {
      let returnValue: ReturnType;

      try {
        returnValue = await routine(tx as unknown as PGlite);
      } catch (error) {
        await tx.rollback();
        throw error;
      }

      return returnValue;
    });
  }

  protected async runQuery<T>(
    connection: PGlite = this.pool,
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const result = await connection.query<T>(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
  }

  // TODO use listening instead, slicker
  public onDeathNote(
    instanceId: string,
    callback: () => void,
    connection: PGlite = this.pool,
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
