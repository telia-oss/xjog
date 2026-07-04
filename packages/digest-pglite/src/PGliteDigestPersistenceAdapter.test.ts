import type { ChartReference } from '@telia-oss/xjog-util';
import { PGliteDigestPersistenceAdapter } from './PGliteDigestPersistenceAdapter';

describe('PGliteDigestPersistenceAdapter', () => {
  const chartReference: ChartReference = {
    machineId: 'test',
    chartId: 'test',
  };

  it('should be defined', () => {
    expect(PGliteDigestPersistenceAdapter).toBeDefined();
  });

  it('should be able to connect to a migrated database', async () => {
    const adapter = await PGliteDigestPersistenceAdapter.connect();
    expect(adapter).toBeDefined();
  });

  it('should read digest', async () => {
    const adapter = await PGliteDigestPersistenceAdapter.connect();
    await adapter.record(chartReference, { foo: 'bar' });

    const result = await adapter.readDigest(chartReference, 'foo');
    expect(result).toMatchObject({
      key: 'foo',
      value: 'bar',
      ref: chartReference,
      created: expect.any(Number),
      timestamp: expect.any(Number),
    });
  });

  it('should clear digest', async () => {
    const testAdapter = await PGliteDigestPersistenceAdapter.connect();

    await testAdapter.record(chartReference, { foo: 'bar' });
    expect(
      testAdapter.readDigest(chartReference, 'foo'),
    ).resolves.toBeDefined();

    await testAdapter.clear(chartReference, ['foo']);
    expect(testAdapter.readDigest(chartReference, 'foo')).resolves.toBeNull();
  });

  it('should filter digests', async () => {
    const testAdapter = await PGliteDigestPersistenceAdapter.connect();
    await testAdapter.record(chartReference, { foo: 'bar' });
    await testAdapter.record(chartReference, { foo: 'baz' });

    const result = await testAdapter.queryDigests();
    expect(result).toHaveLength(1);
    expect(result[0].chartId).toBe(chartReference.chartId);
    expect(result[0].machineId).toBe(chartReference.machineId);
    expect(result[0].timestamp).toBeDefined();
  });

  // Regression: readByChart keyed the result object by machineId, which is
  // constant for a chart, collapsing every digest into a single entry
  it('should key readByChart results by digest key', async () => {
    const adapter = await PGliteDigestPersistenceAdapter.connect();
    await adapter.record(chartReference, { alpha: '1', beta: '2' });

    const digests = await adapter.readByChart(chartReference);
    expect(Object.keys(digests).sort()).toEqual(['alpha', 'beta']);
    expect(digests.alpha).toMatchObject({ key: 'alpha', value: '1' });
    expect(digests.beta).toMatchObject({ key: 'beta', value: '2' });
  });

  // Regression: queryDigests built SQL with fixed placeholder numbers while
  // the parameter array was assembled conditionally, so any combination
  // other than "no arguments" desynced placeholders from values, and the
  // filter expression's bindings were dropped entirely
  it('should apply filter expressions and paging in queryDigests', async () => {
    const adapter = await PGliteDigestPersistenceAdapter.connect();

    const refA: ChartReference = { machineId: 'm1', chartId: 'c1' };
    const refB: ChartReference = { machineId: 'm1', chartId: 'c2' };
    const refC: ChartReference = { machineId: 'm2', chartId: 'c3' };

    await adapter.record(refA, { status: 'done' });
    await adapter.record(refB, { status: 'pending' });
    await adapter.record(refC, { status: 'done' });

    // Filter expression only
    const done = await adapter.queryDigests({
      query: { op: 'eq', left: 'status', right: 'done' },
    });
    expect(
      done.map(({ machineId, chartId }) => `${machineId}/${chartId}`),
    ).toEqual(expect.arrayContaining(['m1/c1', 'm2/c3']));
    expect(done).toHaveLength(2);

    // machineId together with a filter expression
    const doneOnM1 = await adapter.queryDigests({
      machineId: 'm1',
      query: { op: 'eq', left: 'status', right: 'done' },
    });
    expect(doneOnM1).toHaveLength(1);
    expect(doneOnM1[0]).toMatchObject({ machineId: 'm1', chartId: 'c1' });

    // chartId without machineId used to bind to the wrong placeholder
    const byChartId = await adapter.queryDigests({ chartId: 'c2' });
    expect(byChartId).toHaveLength(1);
    expect(byChartId[0]).toMatchObject({ machineId: 'm1', chartId: 'c2' });

    // offset: 0 used to append OFFSET to the SQL but omit its binding
    const paged = await adapter.queryDigests({ offset: 0, limit: 2 });
    expect(paged).toHaveLength(2);
  });

  // Regression: the digest key was interpolated into the binding *name*
  // (`q_eq_${key}`), so a key with a hyphen/dot/digit produced a `:name`
  // token that the placeholder substitution truncated at the first
  // non-word character, binding NULL and leaking the tail into the SQL.
  it('should filter on keys containing non-word characters', async () => {
    const adapter = await PGliteDigestPersistenceAdapter.connect();

    const refA: ChartReference = { machineId: 'm1', chartId: 'c1' };
    const refB: ChartReference = { machineId: 'm1', chartId: 'c2' };

    await adapter.record(refA, { 'user-status.v2': 'done' });
    await adapter.record(refB, { 'user-status.v2': 'pending' });

    const done = await adapter.queryDigests({
      query: { op: 'eq', left: 'user-status.v2', right: 'done' },
    });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ machineId: 'm1', chartId: 'c1' });
  });

  // Regression: the 'updated after' case reused the 'created before' binding
  // key, so its bound value went unused. Exercise the timestamp filter path
  // (untested before) to lock in the binding.
  it('should apply an "updated after" timestamp filter', async () => {
    const adapter = await PGliteDigestPersistenceAdapter.connect();
    await adapter.record(chartReference, { foo: 'bar' });

    // The digest was written "now", so it counts as updated after the epoch...
    const afterEpoch = await adapter.queryDigests({
      query: { op: 'updated after', dateTime: new Date(0) },
    });
    expect(afterEpoch).toHaveLength(1);
    expect(afterEpoch[0]).toMatchObject(chartReference);

    // ...but not after a point in the far future.
    const afterFuture = await adapter.queryDigests({
      query: {
        op: 'updated after',
        dateTime: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    expect(afterFuture).toHaveLength(0);
  });
});
