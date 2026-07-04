import type {
  ChartReferenceWithTimestamp,
  DigestPersistenceAdapter,
  DigestQuery,
} from '@telia-oss/xjog-digest-persistence';
import type { ChartReference } from '@telia-oss/xjog-util';
import { Subject } from 'rxjs';
import { XJogDigestReader } from './XJogDigestReader';

function createPersistence(): DigestPersistenceAdapter & {
  queryDigests: jest.Mock;
} {
  return {
    type: 'test',
    newDigestEntriesSubject: new Subject<ChartReference>(),
    queryDigests: jest.fn(
      async (query: DigestQuery): Promise<ChartReferenceWithTimestamp[]> => [
        {
          machineId: query.machineId ?? 'unknown-machine',
          chartId: query.chartId ?? 'unknown-chart',
          timestamp: Date.now(),
        },
      ],
    ),
  } as unknown as DigestPersistenceAdapter & { queryDigests: jest.Mock };
}

const baseQuery: DigestQuery = { query: { op: 'eq', left: 'a', right: 'b' } };

// Drains the microtask queue (chained promises from the RxJS/async
// interop) without advancing any fake timers.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe('XJogDigestReader.observeDigests', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('emits the initial query result immediately, without waiting for the debounce window', async () => {
    const persistence = createPersistence();
    const reader = new XJogDigestReader(persistence);

    const received: ChartReferenceWithTimestamp[] = [];
    reader.observeDigests(baseQuery).subscribe((ref) => received.push(ref));

    // Flush the microtask queue (the initial queryDigests promise)
    // without advancing any timers - the first result must not wait
    // for the debounce window.
    await flushMicrotasks();

    expect(received).toHaveLength(1);
    expect(persistence.queryDigests).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of notifications into a single re-query per chart', async () => {
    const persistence = createPersistence();
    const reader = new XJogDigestReader(persistence, {
      notificationDebounceMs: 50,
    });

    const received: ChartReferenceWithTimestamp[] = [];
    reader.observeDigests(baseQuery).subscribe((ref) => received.push(ref));

    await flushMicrotasks();
    expect(persistence.queryDigests).toHaveBeenCalledTimes(1);

    // Burst of notifications for the same chart within the window.
    persistence.newDigestEntriesSubject.next({
      machineId: 'm1',
      chartId: 'c1',
    });
    persistence.newDigestEntriesSubject.next({
      machineId: 'm1',
      chartId: 'c1',
    });
    persistence.newDigestEntriesSubject.next({
      machineId: 'm1',
      chartId: 'c1',
    });
    // A distinct chart in the same burst must not be dropped.
    persistence.newDigestEntriesSubject.next({
      machineId: 'm2',
      chartId: 'c2',
    });

    jest.advanceTimersByTime(50);
    await flushMicrotasks();

    // Only one initial call, plus one call per distinct chart -
    // the three m1/c1 notifications collapse into a single re-query.
    expect(persistence.queryDigests).toHaveBeenCalledTimes(3);
    expect(persistence.queryDigests).toHaveBeenNthCalledWith(2, {
      ...baseQuery,
      machineId: 'm1',
      chartId: 'c1',
    });
    expect(persistence.queryDigests).toHaveBeenNthCalledWith(3, {
      ...baseQuery,
      machineId: 'm2',
      chartId: 'c2',
    });
  });
});
