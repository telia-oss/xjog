import path from 'node:path';
import {
  AbstractPostgresJournalPersistenceAdapter,
  type FullStateEntry,
  type JournalEntry,
} from '@telia-oss/xjog-journal-persistence';
import migrationRunner from 'node-pg-migrate';
import { Client, type PoolConfig, type QueryResultRow } from 'pg';
import createSubscriber from 'pg-listen';

/**
 * Options for instantiating {@link PostgresJournalPersistenceAdapter}.
 */
export type PostgresJournalPersistenceAdapterOptions = {
  keyFrameInterval?: number;
};

/**
 * Use the static method `connect` to instantiate.
 * @hideconstructor
 */
export class PostgresJournalPersistenceAdapter extends AbstractPostgresJournalPersistenceAdapter {
  public readonly component = 'journal/persistence';
  public readonly type = 'pg';

  protected readonly newJournalEntryChannel = 'new-journal-entry';

  private readonly stopObservingNewJournalEntries: Promise<() => Promise<void>>;

  public constructor(
    private readonly listenerConfig: PoolConfig,
    private readonly subscriptionConnection: Client,
    private readonly readConnection: Client,
    private readonly writeConnection: Client,
    private readonly updateConnection: Client,
    private options: PostgresJournalPersistenceAdapterOptions,
  ) {
    super();

    subscriptionConnection.on('error', (err) =>
      this.error('Subscription connection emitted error', { err }),
    );
    readConnection.on('error', (err) =>
      this.error('Read connection emitted error', { err }),
    );
    writeConnection.on('error', (err) =>
      this.error('Write connection emitted error', { err }),
    );
    updateConnection.on('error', (err) =>
      this.error('Update connection emitted error', { err }),
    );

    this.stopObservingNewJournalEntries =
      this.startObservingNewJournalEntries();
  }

  /**
   * Create a connection to a [PostgreSql](https://www.postgresql.org/) database
   * and resolve to a JournalPersistenceAdapter that can be passed to the XJog
   * constructor.
   */
  static async connect(
    poolConfiguration: PoolConfig,
    // TODO resolve
    options: Partial<PostgresJournalPersistenceAdapterOptions> = {},
  ): Promise<PostgresJournalPersistenceAdapter> {
    const subscriptionConnection = new Client(poolConfiguration);
    const readConnection = new Client(poolConfiguration);
    const writeConnection = new Client(poolConfiguration);
    const updateConnection = new Client(poolConfiguration);

    const adapter = new PostgresJournalPersistenceAdapter(
      poolConfiguration,
      subscriptionConnection,
      readConnection,
      writeConnection,
      updateConnection,
      options,
    );

    await subscriptionConnection.connect();
    await readConnection.connect();
    await writeConnection.connect();
    await updateConnection.connect();

    // TODO resolve separately
    options.keyFrameInterval ??= 100;

    const migrationClient = new Client(poolConfiguration);
    try {
      await migrationClient.connect();
      await migrationRunner({
        dbClient: migrationClient,
        migrationsTable: 'migrations_journal',
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
    await (await this.stopObservingNewJournalEntries)();

    await this.subscriptionConnection.end();
    await this.updateConnection.end();
    await this.writeConnection.end();
    await this.readConnection.end();
  }

  protected async runWriteQuery<T>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const result = await this.writeConnection.query<QueryResultRow>(
      sql,
      params,
    );
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  protected async runUpdateQuery<T>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const result = await this.updateConnection.query<QueryResultRow>(
      sql,
      params,
    );
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  protected async runReadQuery<T>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const result = await this.readConnection.query<QueryResultRow>(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  private async startObservingNewJournalEntries(): Promise<
    () => Promise<void>
  > {
    const startTime = await this.getCurrentTime();

    let journalEntryIdPointer = 0;
    let fullStateEntryIdPointer = 0;

    const channel = this.newJournalEntryChannel;
    const journalSubscriber = createSubscriber(this.listenerConfig);

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
    // rejection inside the notification dispatch and crash the process.
    journalSubscriber.notifications.on(channel, async () => {
      this.queryEntries({
        afterId: journalEntryIdPointer,
        updatedAfterAndIncluding: startTime,
        order: 'DESC',
      })
        .then((journalEntries) => {
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
        .then((fullStateEntries) => {
          if (fullStateEntries.length) {
            yieldFullStateEntries(fullStateEntries);
          }
        })
        .catch((err) => this.error('Failed to read new full states', { err }));
    });

    journalSubscriber.events.on('error', (error) => {
      this.newJournalEntriesSubject.error(error);
      this.newFullStateEntriesSubject.error(error);
    });

    journalSubscriber
      .connect()
      .then(() => journalSubscriber.listenTo(channel))
      .catch((err) =>
        this.error('Failed to connect journal subscriber', { err }),
      );

    return async () => {
      await journalSubscriber.close();
    };
  }
}
