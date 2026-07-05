import { randomUUID } from 'node:crypto';
import type { PoolConfig } from 'pg';
import { Client } from 'pg';
import { State } from 'xstate';
import { PostgresPersistenceAdapter } from './PostgresPersistenceAdapter';

// `pg`'s Pool/Client give `connectionString` priority over any co-supplied
// discrete fields (e.g. `database`), so `{ connectionString, database }`
// silently connects to the database named in the string, not the override.
// Parse the string into discrete fields so the per-suite `database` override
// in `poolConfigFor` actually takes effect.
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

// These tests exercise the real node-postgres driver against a real
// Postgres server: connection pooling, migrations, and transactions. This
// is exactly what the PGlite suites cannot cover, since they run against an
// in-process WASM database rather than the `pg` driver.
//
// They require a reachable Postgres server. Point PG_TEST_URL (or
// DATABASE_URL) at one to run them; otherwise the whole suite is skipped so
// `pnpm test`/CI `check` stay dependency-free.
const connectionString = process.env.PG_TEST_URL ?? process.env.DATABASE_URL;

const describePg = connectionString ? describe : describe.skip;

describePg('PostgresPersistenceAdapter (real Postgres)', () => {
  const databaseName = `xjog_core_pg_smoke_${randomUUID().replace(/-/g, '')}`;
  // describe.skip still invokes this callback to collect the (skipped)
  // tests, so this must not throw when connectionString is unset.
  const baseConfig = connectionString
    ? basePoolConfigFromConnectionString(connectionString)
    : ({} as PoolConfig);
  let poolConfiguration: PoolConfig;
  let adapter: PostgresPersistenceAdapter;

  beforeAll(async () => {
    // Connect to the base database to create a fresh, isolated database for
    // this suite. node-pg-migrate tracks applied migrations in a table, so
    // sharing a database across the three -pg suites would collide.
    const adminClient = new Client(baseConfig);
    await adminClient.connect();
    try {
      await adminClient.query(`CREATE DATABASE "${databaseName}"`);
    } finally {
      await adminClient.end();
    }

    poolConfiguration = { ...baseConfig, database: databaseName };

    adapter = await PostgresPersistenceAdapter.connect(poolConfiguration);
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

    const result = await adapter.withTransaction(async (client) =>
      client.query(
        `SELECT to_regclass('"charts"') AS "charts", ` +
          `to_regclass('"instances"') AS "instances"`,
      ),
    );

    expect(result.rows[0].charts).toBe('charts');
    expect(result.rows[0].instances).toBe('instances');
  }, 10_000);

  it('withTransaction commits a write that becomes visible afterwards', async () => {
    const ref = { machineId: 'smoke-machine', chartId: 'commit-chart' };

    await adapter.withTransaction(async (client) => {
      await client.query(
        'INSERT INTO "charts" ' +
          '("ownerId", "machineId", "chartId", "state") ' +
          "VALUES ($1, $2, $3, decode('7b7d', 'hex'))",
        ['owner', ref.machineId, ref.chartId],
      );
    });

    expect(await adapter.isChartPresent(ref)).toBe(true);
  }, 10_000);

  it('withTransaction rolls back when the routine throws', async () => {
    const ref = { machineId: 'smoke-machine', chartId: 'rollback-chart' };

    await expect(
      adapter.withTransaction(async (client) => {
        await client.query(
          'INSERT INTO "charts" ' +
            '("ownerId", "machineId", "chartId", "state") ' +
            "VALUES ($1, $2, $3, decode('7b7d', 'hex'))",
          ['owner', ref.machineId, ref.chartId],
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await adapter.isChartPresent(ref)).toBe(false);
  }, 10_000);

  it('destroyChart removes a previously created chart', async () => {
    const ref = { machineId: 'smoke-machine', chartId: 'destroy-chart' };

    await adapter.createChart(
      'owner',
      ref,
      State.from('idle', {}),
      null,
      'cid-smoke-destroy',
    );
    expect(await adapter.isChartPresent(ref)).toBe(true);

    await adapter.destroyChart(ref, 'cid-smoke-destroy');
    expect(await adapter.isChartPresent(ref)).toBe(false);
  }, 10_000);
});
