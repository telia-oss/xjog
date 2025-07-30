import { ChartReference } from '@samihult/xjog-util';
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
});
