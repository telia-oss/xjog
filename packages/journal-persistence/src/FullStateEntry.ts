import type {
  ChartReference,
  XJogStateChangeAction,
} from '@telia-oss/xjog-util';
import type { EventObject, StateValue } from 'xstate';

export type FullStateEntry = {
  id: number;
  created: number;
  timestamp: number;

  ownerId: string;
  ref: ChartReference;
  parentRef: ChartReference | null;

  event: EventObject | null;
  state: StateValue | null;
  context: any | null;
  actions: XJogStateChangeAction[] | null;
};
