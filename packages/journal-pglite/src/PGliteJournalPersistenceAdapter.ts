import path from 'node:path';
import { PGlite, type PGliteOptions } from '@electric-sql/pglite';
import {
  AbstractPostgresJournalPersistenceAdapter,
  type FullStateEntry,
  type JournalEntry,
} from '@telia-oss/xjog-journal-persistence';
import migrationRunner from 'node-pg-migrate';

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
export class PGliteJournalPersistenceAdapter extends AbstractPostgresJournalPersistenceAdapter {
  public readonly component = 'journal/persistence';
  public readonly type = 'pglite';

  protected readonly newJournalEntryChannel = 'new_journal_entry';

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

  protected async runWriteQuery<T>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const result = await this.connection.query<T>(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
  }

  protected async runUpdateQuery<T>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const result = await this.connection.query<T>(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
  }

  protected async runReadQuery<T>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const result = await this.connection.query<T>(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
  }

  private async startObservingNewJournalEntries(): Promise<
    () => Promise<void>
  > {
    const startTime = await this.getCurrentTime();

    let journalEntryIdPointer = 0;
    let fullStateEntryIdPointer = 0;

    const channel = this.newJournalEntryChannel;

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
}
