import { randomUUID } from 'node:crypto';
import type { ChartReference } from '@telia-oss/xjog-util';
import type { PoolConfig } from 'pg';
import { Client } from 'pg';
import { PostgresDigestPersistenceAdapter } from './PostgresDigestPersistenceAdapter';

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

describePg('PostgresDigestPersistenceAdapter (real Postgres)', () => {
  const databaseName = `xjog_digest_pg_smoke_${randomUUID().replace(/-/g, '')}`;
  // describe.skip still invokes this callback to collect the (skipped)
  // tests, so this must not throw when connectionString is unset.
  const baseConfig = connectionString
    ? basePoolConfigFromConnectionString(connectionString)
    : ({} as PoolConfig);
  let poolConfiguration: PoolConfig;
  let adapter: PostgresDigestPersistenceAdapter;

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

    adapter = await PostgresDigestPersistenceAdapter.connect(poolConfiguration);
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

    const ref: ChartReference = { machineId: 'smoke-machine', chartId: 'x' };
    const digest = await adapter.readDigest(ref, 'nonexistent');
    expect(digest).toBeNull();
  }, 10_000);

  it('emits a digest notification through a real LISTEN/NOTIFY round trip', async () => {
    const ref: ChartReference = {
      machineId: 'smoke-machine',
      chartId: 'listen-notify-chart',
    };

    // Subscribe before writing so the emission cannot be missed.
    const nextNotification = new Promise<ChartReference>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for a digest notification')),
        10_000,
      );
      const subscription = adapter.newDigestEntriesSubject.subscribe({
        next: (notifiedRef) => {
          clearTimeout(timer);
          subscription.unsubscribe();
          resolve(notifiedRef);
        },
        error: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });

    await adapter.record(ref, { foo: 'bar' });

    const notifiedRef = await nextNotification;
    expect(notifiedRef).toEqual(ref);

    const digest = await adapter.readDigest(ref, 'foo');
    expect(digest).toMatchObject({ key: 'foo', value: 'bar', ref });
  }, 15_000);
});
