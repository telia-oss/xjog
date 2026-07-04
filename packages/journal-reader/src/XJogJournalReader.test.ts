import type {
  FullStateEntry,
  FullStateQuery,
  JournalEntry,
  JournalQuery,
} from '@telia-oss/xjog-journal-persistence';
import { JournalPersistenceAdapter } from '@telia-oss/xjog-journal-persistence';
import type { ChartReference } from '@telia-oss/xjog-util';
import { applyPatch, createPatch } from 'rfc6902';

import { XJogJournalReader } from './XJogJournalReader';

const ref: ChartReference = { machineId: 'machine', chartId: 'chart-1' };

/**
 * A tiny in-memory persistence adapter, just enough to exercise
 * `readMergedJournalEntry`. Journal entries are stored newest-first, which
 * is how `readEntry`/`queryEntries` are used by the reader (order: 'DESC').
 */
class FakePersistence extends JournalPersistenceAdapter {
  public readonly type = 'fake';

  constructor(
    private readonly fullState: FullStateEntry,
    // Entries in DESC id order, i.e. newest first, matching what the
    // reader requests from `queryEntries`.
    private readonly entries: JournalEntry[],
  ) {
    super();
  }

  protected insertEntry(): never {
    throw new Error('not implemented');
  }

  protected updateFullState(): never {
    throw new Error('not implemented');
  }

  protected emitJournalEntryNotification(): never {
    throw new Error('not implemented');
  }

  public async readEntry(id: number): Promise<JournalEntry | null> {
    return this.entries.find((entry) => entry.id === id) ?? null;
  }

  public async queryEntries(_query: JournalQuery): Promise<JournalEntry[]> {
    return this.entries;
  }

  public async readFullState(
    chartRef: ChartReference,
  ): Promise<FullStateEntry | null> {
    return chartRef.chartId === this.fullState.ref.chartId
      ? this.fullState
      : null;
  }

  public async queryFullStates(
    _query: FullStateQuery,
  ): Promise<FullStateEntry[]> {
    return [this.fullState];
  }

  public async getCurrentTime(): Promise<number> {
    return Date.now();
  }

  public async deleteByChart(): Promise<number> {
    return 0;
  }
}

/**
 * Builds a chain of journal entries the way `JournalPersistenceAdapter.record`
 * would: each entry's stateDelta/contextDelta is a patch that travels
 * *backward* from the following (newer) state/context to the previous one.
 * `states`/`contexts` are given oldest-first; the returned full state is the
 * newest one, and entries are returned newest-first (DESC), matching what
 * `readMergedJournalEntry` queries for.
 */
function buildHistory(
  states: unknown[],
  contexts: unknown[],
  events: Array<{ type: string }>,
) {
  const fullState: FullStateEntry = {
    id: states.length,
    created: 0,
    timestamp: 0,
    ownerId: 'owner',
    ref,
    parentRef: null,
    event: events[events.length - 1],
    state: states[states.length - 1] as any,
    context: contexts[contexts.length - 1],
    actions: null,
  };

  const entries: JournalEntry[] = [];
  for (let i = states.length - 1; i > 0; i--) {
    entries.push({
      id: i + 1,
      timestamp: 0,
      ref,
      event: events[i],
      state: states[i] as any,
      context: contexts[i],
      actions: null,
      stateDelta: createPatch(states[i], states[i - 1]),
      contextDelta: createPatch(contexts[i], contexts[i - 1]),
    });
  }
  // Newest first (DESC), as returned by `queryEntries` in the reader.
  entries.sort((a, b) => b.id - a.id);

  return { fullState, entries };
}

describe('XJogJournalReader.readMergedJournalEntry', () => {
  it('merges a multi-entry chain into the expected previous state/context at each step', async () => {
    const states = [{ value: 'start' }, { value: 'middle' }, { value: 'end' }];
    const contexts = [{ count: 0 }, { count: 1 }, { count: 2 }];
    const events = [{ type: 'INIT' }, { type: 'STEP' }, { type: 'FINISH' }];

    const { fullState, entries } = buildHistory(states, contexts, events);
    const reader = new XJogJournalReader(
      new FakePersistence(fullState, entries),
    );

    const merged = await reader.readMergedJournalEntry(fullState.id);

    expect(merged).not.toBeNull();
    // `.state`/`.context` end up one step behind `.previousState`/
    // `.previousContext` because each iteration first rolls `state` back to
    // the previous iteration's `previousState` before computing the next
    // rollback - this is the existing (pre-refactor) fold semantics, which
    // this test pins down as a regression guard.
    expect(merged!.state).toEqual(states[1]);
    expect(merged!.context).toEqual(contexts[1]);
    // Walking every recorded delta back to the oldest recorded step.
    expect(merged!.previousState).toEqual(states[0]);
    expect(merged!.previousContext).toEqual(contexts[0]);

    // The full state's own state/context objects must not have been
    // mutated by applying patches in place (regression guard for the
    // single-working-copy optimization).
    expect(fullState.state).toEqual(states[2]);
    expect(fullState.context).toEqual(contexts[2]);
  });

  it('produces the same merged result with the optimized fold as a from-scratch clone-per-step computation', async () => {
    const states = [
      { a: 1, nested: { b: 'x' } },
      { a: 2, nested: { b: 'y' } },
      { a: 3, nested: { b: 'z' } },
      { a: 4, nested: { b: 'w' } },
    ];
    const contexts = [
      { items: [1] },
      { items: [1, 2] },
      { items: [1, 2, 3] },
      { items: [1, 2, 3, 4] },
    ];
    const events = states.map((_, i) => ({ type: `EVENT_${i}` }));

    const { fullState, entries } = buildHistory(states, contexts, events);
    const reader = new XJogJournalReader(
      new FakePersistence(fullState, entries),
    );

    const merged = await reader.readMergedJournalEntry(fullState.id);

    // Independently reconstruct the expected previousState/previousContext
    // by reapplying every delta against a fresh deep clone each time (the
    // pre-optimization approach), and compare byte-for-byte via deep equal.
    let expectedState: unknown = JSON.parse(JSON.stringify(states[3]));
    let expectedContext: unknown = JSON.parse(JSON.stringify(contexts[3]));
    for (const entry of entries) {
      const stateClone = JSON.parse(JSON.stringify(expectedState));
      applyPatch(stateClone, entry.stateDelta);
      expectedState = stateClone;

      const contextClone = JSON.parse(JSON.stringify(expectedContext));
      applyPatch(contextClone, entry.contextDelta);
      expectedContext = contextClone;
    }

    expect(merged!.previousState).toEqual(expectedState);
    expect(merged!.previousContext).toEqual(expectedContext);
    expect(merged!.previousState).toEqual(states[0]);
    expect(merged!.previousContext).toEqual(contexts[0]);

    // The final state/previousState (and context/previousContext) must be
    // independent objects, exactly like the old clone-per-step
    // implementation - never aliased to one another, or a mutation of one
    // returned field could silently corrupt the other.
    expect(merged!.state).not.toBe(merged!.previousState);
    expect(merged!.context).not.toBe(merged!.previousContext);
  });

  it('matches a reference clone-per-step fold across many random chains (differential fuzz)', async () => {
    function referenceNullSafeApplyJsonDiff(input: any, patch: any[]): any {
      if (
        patch.length === 1 &&
        patch[0].op === 'replace' &&
        patch[0].path === ''
      ) {
        return patch[0].value ?? null;
      } else if (
        typeof input === 'string' ||
        typeof input === 'number' ||
        input === null ||
        input === undefined
      ) {
        throw new Error('Complex patch but input is not an object');
      }
      const output = JSON.parse(JSON.stringify(input));
      applyPatch(output, patch);
      return output;
    }

    function randomValue(rng: () => number, depth = 0): any {
      const roll = rng();
      if (depth > 2 || roll < 0.3) {
        return Math.floor(rng() * 1000);
      }
      if (roll < 0.45) {
        return rng() < 0.5;
      }
      if (roll < 0.6) {
        return '';
      }
      if (roll < 0.7) {
        return `str-${Math.floor(rng() * 100)}`;
      }
      if (roll < 0.85) {
        return Array.from({ length: 1 + Math.floor(rng() * 3) }, () =>
          randomValue(rng, depth + 1),
        );
      }
      return {
        a: randomValue(rng, depth + 1),
        b: randomValue(rng, depth + 1),
        c: `leaf-${Math.floor(rng() * 100)}`,
      };
    }

    // Deterministic PRNG (mulberry32) so failures are reproducible.
    function mulberry32(seed: number) {
      let a = seed;
      return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    for (let seed = 0; seed < 25; seed++) {
      const rng = mulberry32(seed);
      const chainLength = 2 + Math.floor(rng() * 5);

      const states = Array.from({ length: chainLength }, () =>
        randomValue(rng),
      );
      const contexts = Array.from({ length: chainLength }, () =>
        randomValue(rng),
      );
      const events = states.map((_, i) => ({ type: `EVENT_${i}` }));

      const { fullState, entries } = buildHistory(states, contexts, events);
      const reader = new XJogJournalReader(
        new FakePersistence(fullState, entries),
      );

      // The reference fold below is the literal pre-refactor algorithm
      // (clone-per-step, via the real nullSafeApplyJsonDiff semantics). Some
      // random chains legitimately hit nullSafeApplyJsonDiff's documented
      // guard (a no-op patch against a string/number/null/undefined value)
      // and are expected to throw in *both* implementations - assert that
      // symmetry rather than silently skipping those seeds.
      let referenceThrew = false;
      let referenceState: unknown = states[chainLength - 1];
      let referenceContext: unknown = contexts[chainLength - 1];
      let referencePreviousState: unknown = null;
      let referencePreviousContext: unknown = null;

      try {
        for (const entry of entries) {
          if (referencePreviousState !== null) {
            referenceState = referencePreviousState;
          }
          if (referencePreviousContext !== null) {
            referenceContext = referencePreviousContext;
          }
          referencePreviousState = referenceNullSafeApplyJsonDiff(
            referenceState,
            entry.stateDelta,
          );
          referencePreviousContext = referenceNullSafeApplyJsonDiff(
            referenceContext,
            entry.contextDelta,
          );
        }
      } catch {
        referenceThrew = true;
      }

      if (referenceThrew) {
        await expect(
          reader.readMergedJournalEntry(fullState.id),
        ).rejects.toThrow('Complex patch but input is not an object');
        continue;
      }

      const merged = await reader.readMergedJournalEntry(fullState.id);

      expect(merged!.state).toEqual(referenceState);
      expect(merged!.context).toEqual(referenceContext);
      expect(merged!.previousState).toEqual(referencePreviousState);
      expect(merged!.previousContext).toEqual(referencePreviousContext);
    }
  });

  it('treats falsy-but-valid previousState/previousContext values as valid (explicit !== null check)', async () => {
    // A root-replace delta produces an aliased, non-cloned value (see
    // nullSafeApplyJsonDiff's fast path) - here we exercise falsy scalars
    // (0, '', false) to make sure the reader does not mistake them for
    // "no previous value" the way a truthiness check would.
    const states = [false, true];
    const contexts = [0, 1];
    const events = [{ type: 'INIT' }, { type: 'STEP' }];

    const { fullState, entries } = buildHistory(states, contexts, events);
    const reader = new XJogJournalReader(
      new FakePersistence(fullState, entries),
    );

    const merged = await reader.readMergedJournalEntry(fullState.id);

    expect(merged).not.toBeNull();
    expect(merged!.state).toBe(true);
    expect(merged!.context).toBe(1);
    // Falsy but valid: previousState/previousContext must resolve to the
    // actual recorded falsy values, not be skipped/overwritten as if null.
    expect(merged!.previousState).toBe(false);
    expect(merged!.previousContext).toBe(0);
  });

  it('returns null when the journal entry does not exist', async () => {
    const { fullState, entries } = buildHistory(
      [{ value: 'a' }],
      [{ count: 0 }],
      [{ type: 'INIT' }],
    );
    const reader = new XJogJournalReader(
      new FakePersistence(fullState, entries),
    );

    expect(await reader.readMergedJournalEntry(9999)).toBeNull();
  });

  it('reads the id at the head of history (no journal entries to fold) without cloning', async () => {
    // `readEntry` must find an entry to resolve the chart ref, but the fold
    // query (`queryEntries`) returns none - there is nothing older to fold
    // in, so the loop body never runs and the full state's own state/context
    // should come back untouched (same object identity, not even the
    // "clone once up front" step happens).
    const { fullState, entries } = buildHistory(
      [{ value: 'previous' }, { value: 'only' }],
      [{ count: 0 }, { count: 1 }],
      [{ type: 'INIT' }, { type: 'STEP' }],
    );

    class NoFoldPersistence extends FakePersistence {
      public async queryEntries(): Promise<JournalEntry[]> {
        return [];
      }
    }
    const reader = new XJogJournalReader(
      new NoFoldPersistence(fullState, entries),
    );

    const merged = await reader.readMergedJournalEntry(fullState.id);

    expect(merged).not.toBeNull();
    expect(merged!.state).toBe(fullState.state);
    expect(merged!.context).toBe(fullState.context);
    expect(merged!.previousState).toBeNull();
    expect(merged!.previousContext).toBeNull();
  });
});
