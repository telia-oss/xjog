import { XJogProfiler } from './XJogProfiler';

describe('XJogProfiler', () => {
  it('records durations and exposes them via getProfilingMetrics when enabled', async () => {
    const profiler = new XJogProfiler(true);

    await profiler.timeExecution('op', async () => {
      // no-op
    });

    const metrics = profiler.getProfilingMetrics();

    expect(metrics.executions.op).toBeDefined();
    expect(metrics.executions.op.count).toBe(1);
    expect(typeof metrics.executions.op.total).toBe('number');
  });

  it('short-circuits to just invoking the routine when disabled', async () => {
    const profiler = new XJogProfiler(false);

    const performanceNowSpy = jest.spyOn(performance, 'now');

    const syncResult = profiler.timeExecution('op', () => 42);
    expect(syncResult).toBe(42);

    const asyncResult = await profiler.timeExecution('op', async () => 'hi');
    expect(asyncResult).toBe('hi');

    // No timing math should have happened at all.
    expect(performanceNowSpy).not.toHaveBeenCalled();

    // Nothing should have been recorded either.
    const metrics = profiler.getProfilingMetrics();
    expect(metrics.executions).toEqual({});

    performanceNowSpy.mockRestore();
  });

  it('propagates synchronous throws when disabled', () => {
    const profiler = new XJogProfiler(false);

    expect(() =>
      profiler.timeExecution('op', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
  });

  it('propagates async rejections when disabled', async () => {
    const profiler = new XJogProfiler(false);

    await expect(
      profiler.timeExecution('op', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
