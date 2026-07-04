import type {
  ChartReferenceWithTimestamp,
  DigestPersistenceAdapter,
  DigestQuery,
} from '@telia-oss/xjog-digest-persistence';
import { type ChartReference, XJogLogEmitter } from '@telia-oss/xjog-util';
import {
  bufferTime,
  concat,
  concatMap,
  filter,
  from,
  type Observable,
} from 'rxjs';
import type { XJogDigestReaderOptions } from './XJogDigestReaderOptions';
import type { XJogDigestReaderResolvedOptions } from './XJogDigestReaderResolvedOptions';

const defaultNotificationDebounceMs = 50;

export class XJogDigestReader extends XJogLogEmitter {
  public readonly component = 'digest/reader';

  private readonly options: XJogDigestReaderResolvedOptions;

  constructor(
    private readonly persistence: DigestPersistenceAdapter,
    options?: XJogDigestReaderOptions,
  ) {
    super();

    this.options = {
      notificationDebounceMs:
        options?.notificationDebounceMs ?? defaultNotificationDebounceMs,
    };
  }

  public async queryDigests(
    query: DigestQuery,
  ): Promise<ChartReferenceWithTimestamp[]> {
    return this.persistence.queryDigests(query);
  }

  public observeDigests(
    query: DigestQuery,
  ): Observable<ChartReferenceWithTimestamp> {
    return concat(
      from(this.queryDigests(query)).pipe(
        // From array to individual items
        concatMap((refs: ChartReferenceWithTimestamp[]) => refs),
      ),
      from(this.persistence.newDigestEntriesSubject).pipe(
        // Coalesce bursts of notifications into batches so that many
        // notifications arriving in quick succession trigger fewer
        // `queryDigests` calls. Each batch is deduplicated by
        // machineId/chartId before re-querying, so no distinct chart
        // notification is dropped - only redundant re-queries for the
        // same chart within the window are collapsed.
        bufferTime(this.options.notificationDebounceMs),
        filter((refs: ChartReference[]) => refs.length > 0),
        concatMap((refs: ChartReference[]) => dedupeRefs(refs)),
        concatMap((ref: ChartReference) => {
          return this.persistence.queryDigests({
            ...query,
            machineId: ref.machineId,
            chartId: ref.chartId,
          });
        }),
        // From array to individual items
        concatMap((refs: ChartReferenceWithTimestamp[]) => refs),
      ),
    );
  }
}

function dedupeRefs(refs: ChartReference[]): ChartReference[] {
  const seen = new Map<string, ChartReference>();
  for (const ref of refs) {
    seen.set(`${ref.machineId}:${ref.chartId}`, ref);
  }
  return [...seen.values()];
}
