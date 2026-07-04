import type {
  ChartReference,
  XJogStateChangeAction,
} from '@telia-oss/xjog-util';
import type { Operation } from 'rfc6902';
import type { EventObject, StateValue } from 'xstate';

export type JournalEntry = {
  id: number;
  timestamp: number;
  ref: ChartReference;

  event: EventObject | null;
  state: StateValue | null;
  context: any | null;
  actions: XJogStateChangeAction[] | null;

  stateDelta: Operation[];
  contextDelta: Operation[];
};

export type JournalEntryAutoFields = {
  id: number;
  timestamp: number;
};

export type JournalEntryInsertFields = {
  ref: ChartReference;
  event: EventObject | null;
  stateDelta: Operation[];
  contextDelta: Operation[];
  actions: XJogStateChangeAction[] | null;
};
