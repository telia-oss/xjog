import { isPromiseLike } from 'xstate/lib/utils';

/**
 * Tracks execution durations for named operations as log-scaled histograms,
 * composed into {@link XJog} to keep the profiling machinery isolated from
 * the rest of the instance's responsibilities.
 */
export class XJogProfiler {
  private readonly enabled: boolean;

  private executionDurationHistogramBase = 2;
  private executionDurationHistogramBuckets = 16;

  private executionDurationHistogramBaseLog = Math.log(
    this.executionDurationHistogramBase,
  );

  private executionDurationHistogramBucketCeilingValues = [
    ...new Array(this.executionDurationHistogramBuckets),
  ].map((value, index) => this.executionDurationHistogramBase ** index);

  private executionTimes: { [op: string]: number } = {};
  private executionDurationHistograms: { [op: string]: number[] } = {};

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  private getExecutionDurationHistogram(op: string): number[] {
    if (!this.executionDurationHistograms[op]) {
      this.executionDurationHistograms[op] = new Array(
        this.executionDurationHistogramBuckets,
      ).fill(0);
    }

    return this.executionDurationHistograms[op];
  }

  private recordExecutionDuration(op: string, duration: number) {
    let bucket;

    const ceilingDuration = Math.ceil(duration);

    if (ceilingDuration <= 0) {
      bucket = 0;
    } else {
      bucket = Math.ceil(
        Math.log(ceilingDuration) / this.executionDurationHistogramBaseLog,
      );
    }

    if (bucket >= this.executionDurationHistogramBuckets) {
      bucket = this.executionDurationHistogramBuckets;
    }

    this.getExecutionDurationHistogram(op)[bucket]++;
    this.executionTimes[op] = (this.executionTimes[op] ?? 0) + duration;
  }

  public timeExecution<T>(op: string, routine: () => T): T {
    if (!this.enabled) {
      return routine();
    }

    const startTime = performance.now();
    const returnValue = routine();

    const done = () =>
      this.recordExecutionDuration(op, performance.now() - startTime);

    if (isPromiseLike(returnValue)) {
      // @ts-expect-error Trust that it has `finally`
      return returnValue.finally(done) as unknown as T;
    }

    done();

    return returnValue;
  }

  public getProfilingMetrics(): {
    buckets: number[];
    executions: {
      [op: string]: {
        count: number;
        total: number;
        histogram: number[];
      };
    };
  } {
    return {
      buckets: this.executionDurationHistogramBucketCeilingValues,
      executions: Object.keys(this.executionDurationHistograms)
        .sort()
        .reduce((entry, key) => {
          const histogram = this.executionDurationHistograms[key];

          const count = histogram.reduce((sum, bucket) => sum + bucket, 0);
          const total = this.executionTimes[key];

          return {
            ...entry,
            [key]: {
              count,
              total,
              histogram,
            },
          };
        }, {}),
    };
  }
}
