import type { FullStateEntry } from '@telia-oss/xjog-journal-persistence';
import type { Operation } from 'rfc6902';
import type { StateValue } from 'xstate';

export type MergedJournalEntry = FullStateEntry & {
  stateDelta: Operation[];
  contextDelta: Operation[];
  previousState: StateValue | null;
  previousContext: any | null;
};
