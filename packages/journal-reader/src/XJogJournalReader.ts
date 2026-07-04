import type {
  FullStateEntry,
  FullStateQuery,
  JournalEntry,
  JournalPersistenceAdapter,
  JournalQuery,
} from '@telia-oss/xjog-journal-persistence';
import { XJogLogEmitter } from '@telia-oss/xjog-util';
import { applyPatch, type Operation } from 'rfc6902';
import { concat, concatMap, from, type Observable } from 'rxjs';

import type { MergedJournalEntry } from './MergedJournalEntry';

/**
 * Result of applying a single diff step in the merge fold below.
 *
 * `owned` tracks whether `value` is a working copy we are free to mutate
 * in place on the next step, or whether it is aliased to data we do not
 * own (e.g. a value lifted straight out of a patch), in which case it
 * must be cloned before any further in-place mutation.
 */
type FoldStep = {
  value: any;
  owned: boolean;
};

/**
 * Applies a single rfc6902 patch the same way `nullSafeApplyJsonDiff` does,
 * but without unconditionally deep-cloning the input on every call: when
 * `current.owned` is `true` (and `forceClone` is not requested) we mutate
 * `current.value` in place, matching `nullSafeApplyJsonDiff`'s semantics
 * exactly (including its root-replace shortcut and its guard against
 * patching a scalar/null/undefined value) while avoiding the
 * `JSON.parse(JSON.stringify(...))` clone on every fold step.
 *
 * `forceClone` must be passed on the final fold step so that the returned
 * value never ends up aliasing `current.value` (which the caller may also
 * expose separately) - this mirrors `nullSafeApplyJsonDiff` always
 * returning a value independent from its input on the non-shortcut path.
 */
function applyJsonDiffStep(
  current: FoldStep,
  patch: Operation[],
  forceClone: boolean,
): FoldStep {
  if (patch.length === 1 && patch[0].op === 'replace' && patch[0].path === '') {
    // Same as nullSafeApplyJsonDiff: the replacement value is used as-is,
    // aliased directly from the patch, so it is not something we own.
    return { value: patch[0].value ?? null, owned: false };
  }

  if (
    typeof current.value === 'string' ||
    typeof current.value === 'number' ||
    current.value === null ||
    current.value === undefined
  ) {
    throw new Error('Complex patch but input is not an object');
  }

  const working =
    current.owned && !forceClone
      ? current.value
      : JSON.parse(JSON.stringify(current.value));

  applyPatch(working, patch);

  return { value: working, owned: true };
}

export class XJogJournalReader extends XJogLogEmitter {
  public readonly component = 'journal/reader';

  constructor(private readonly persistence: JournalPersistenceAdapter) {
    super();
  }

  public observeFullStates(query: FullStateQuery): Observable<FullStateEntry> {
    return concat(
      from(this.persistence.queryFullStates(query)).pipe(
        // From array to individual items
        concatMap((entry: FullStateEntry[]) => entry),
      ),
      this.persistence.newFullStateEntries(query),
    );
  }

  public observeJournal(query: JournalQuery): Observable<JournalEntry> {
    return concat(
      from(this.persistence.queryEntries(query)).pipe(
        // From array to individual items
        concatMap((entry: JournalEntry[]) => entry),
      ),
      this.persistence.newJournalEntries(query),
    );
  }

  public async readMergedJournalEntry(
    id: number,
  ): Promise<MergedJournalEntry | null> {
    const journalEntry = await this.persistence.readEntry(id);

    if (!journalEntry) {
      return null;
    }

    const fullState = await this.persistence.readFullState(journalEntry.ref);

    if (!fullState) {
      return null;
    }

    const journalEntries = await this.persistence.queryEntries({
      ref: journalEntry.ref,
      afterAndIncludingId: id,
      order: 'DESC',
    });

    // `state`/`context`/`previousState`/`previousContext` are only ever
    // read back as inputs to the next diff step within this loop - none of
    // them are observed from the outside until the loop finishes - so they
    // are tracked as local working copies here and written to
    // `mergedJournalEntry` once, at the end. This lets a single owned
    // working copy be mutated in place across the whole fold instead of
    // deep-cloning on every journal entry, without ever aliasing that
    // mutable copy into a field that's exposed early.
    let event = fullState.event;
    let state: FoldStep = { value: fullState.state, owned: false };
    let previousState: FoldStep | null = null;
    let context: FoldStep = { value: fullState.context, owned: false };
    let previousContext: FoldStep | null = null;

    for (const [index, journalEntry] of journalEntries.entries()) {
      event = journalEntry.event;

      if (previousState !== null) {
        state = previousState;
      }

      if (previousContext !== null) {
        context = previousContext;
      }

      // On the last step, force a clone so the returned previousState/
      // previousContext never end up aliasing the state/context snapshot
      // returned alongside them (see applyJsonDiffStep's doc comment).
      const isLastStep = index === journalEntries.length - 1;

      previousState = applyJsonDiffStep(
        state,
        journalEntry.stateDelta,
        isLastStep,
      );
      previousContext = applyJsonDiffStep(
        context,
        journalEntry.contextDelta,
        isLastStep,
      );
    }

    return {
      ...fullState,
      stateDelta: [],
      contextDelta: [],
      event,
      state: state.value,
      context: context.value,
      previousState: previousState?.value ?? null,
      previousContext: previousContext?.value ?? null,
    };
  }
}
