import { randomUUID } from 'node:crypto';
import type { JournalEntry } from '@telia-oss/xjog-journal-persistence';
import type { XJogStateChangeAction } from '@telia-oss/xjog-util';
import type { PoolConfig } from 'pg';
import { Client } from 'pg';
import { PostgresJournalPersistenceAdapter } from './PostgresJournalPersistenceAdapter';

// `pg`'s Pool/Client give `connectionString` priority over any co-supplied
// discrete fields (e.g. `database`), so `{ connectionString, database }`
// silently connects to the database named in the string, not the override.
// Parse the string into discrete fields so the per-suite `database` override
// below actually takes effect.
function basePoolConfigFromConnectionString(raw: string): PoolConfig {
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };
}

// These tests exercise the real node-postgres driver and pg-listen against a
// real Postgres server: connection pooling, migrations, and a real
// LISTEN/NOTIFY round trip. This is exactly what the PGlite suite cannot
// cover, since PGlite has no separate server process to NOTIFY through.
//
// They require a reachable Postgres server. Point PG_TEST_URL (or
// DATABASE_URL) at one to run them; otherwise the whole suite is skipped so
// `pnpm test`/CI `check` stay dependency-free.
const connectionString = process.env.PG_TEST_URL ?? process.env.DATABASE_URL;

const describePg = connectionString ? describe : describe.skip;

describePg('PostgresJournalPersistenceAdapter (real Postgres)', () => {
  const databaseName = `xjog_journal_pg_smoke_${randomUUID().replace(/-/g, '')}`;
  // describe.skip still invokes this callback to collect the (skipped)
  // tests, so this must not throw when connectionString is unset.
  const baseConfig = connectionString
    ? basePoolConfigFromConnectionString(connectionString)
    : ({} as PoolConfig);
  let poolConfiguration: PoolConfig;
  let adapter: PostgresJournalPersistenceAdapter;

  beforeAll(async () => {
    // Isolated, per-suite database: node-pg-migrate tracks applied
    // migrations in a table, so sharing a database across the three -pg
    // suites would collide.
    const adminClient = new Client(baseConfig);
    await adminClient.connect();
    try {
      await adminClient.query(`CREATE DATABASE "${databaseName}"`);
    } finally {
      await adminClient.end();
    }

    poolConfiguration = { ...baseConfig, database: databaseName };

    adapter =
      await PostgresJournalPersistenceAdapter.connect(poolConfiguration);
  }, 30_000);

  afterAll(async () => {
    await adapter?.disconnect();

    const adminClient = new Client(baseConfig);
    await adminClient.connect();
    try {
      await adminClient.query(
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
      );
    } finally {
      await adminClient.end();
    }
  }, 30_000);

  it('connects and applies migrations without throwing', async () => {
    expect(adapter).toBeDefined();

    const entry = await adapter.readEntry(1);
    expect(entry).toBeNull();
  }, 10_000);

  it('emits a journal-entry notification through a real LISTEN/NOTIFY round trip', async () => {
    const ref = { machineId: 'smoke-machine', chartId: 'listen-notify-chart' };
    const actions: XJogStateChangeAction[] = [];

    // Subscribe before writing so the emission cannot be missed.
    const nextEntry = new Promise<JournalEntry>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error('Timed out waiting for a journal entry notification'),
          ),
        10_000,
      );
      const subscription = adapter.newJournalEntries({ ref }).subscribe({
        next: (entry) => {
          clearTimeout(timer);
          subscription.unsubscribe();
          resolve(entry);
        },
        error: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });

    await adapter.record(
      'owner',
      ref,
      null,
      { type: 'smoke-event' },
      null,
      null,
      { state: 'new' },
      { ctx: 'new' },
      actions,
      'cid-smoke-listen',
    );

    const entry = await nextEntry;
    expect(entry.ref).toEqual(ref);
    expect(entry.event).toEqual({ type: 'smoke-event' });
  }, 15_000);
});
