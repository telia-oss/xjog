import type { EventObject, StateValue } from 'xstate';
import type { ActionTypes } from 'xstate/lib/types';
import type { ChartReference } from './ChartReference';
import type { XJogActionTypes } from './XJogActionTypes';

export type XJogStateChangeSendAction = {
  type: ActionTypes.Send;
  sendId: string | number;
  eventType: string;
  to: string;
};

export type XJogStateChangeCancelAction = {
  type: ActionTypes.Cancel;
  sendId: string | number;
};

export type XJogStateChangeStartAction = {
  type: ActionTypes.Start;
  activityId: string;
  activityType: string;
};

export type XJogStateChangeStopAction = {
  type: ActionTypes.Stop;
  activityId: string;
  activityType: string;
};

/**
 * Built-in xstate action types that XJog records by type only. Their resolved
 * action objects either carry no payload worth journaling or carry values
 * (assignment/expression functions) that cannot be serialized.
 */
export type XJogStateChangePlainActionType =
  | ActionTypes.Raise
  | ActionTypes.Assign
  | ActionTypes.After
  | ActionTypes.DoneState
  | ActionTypes.DoneInvoke
  | ActionTypes.Log
  | ActionTypes.Init
  | ActionTypes.Invoke
  | ActionTypes.ErrorExecution
  | ActionTypes.ErrorCommunication
  | ActionTypes.ErrorPlatform
  | ActionTypes.ErrorCustom
  | ActionTypes.Update
  | ActionTypes.Pure
  | ActionTypes.Choose;

export type XJogStateChangePlainAction = {
  type: XJogStateChangePlainActionType;
};

/** Any action type XJog does not recognize, e.g. user-defined actions. */
export type XJogStateChangeUnknownAction = {
  type: XJogActionTypes.Unknown;
  actionType: string;
};

export type XJogStateChangeAction =
  | XJogStateChangeSendAction
  | XJogStateChangeCancelAction
  | XJogStateChangeStartAction
  | XJogStateChangeStopAction
  | XJogStateChangePlainAction
  | XJogStateChangeUnknownAction;

export type XJogStateChangeState = {
  value: StateValue;
  context: any;
  actions: XJogStateChangeAction[];
};

export type XJogStateChange = {
  type: 'create' | 'update' | 'delete';
  ref: ChartReference;
  parentRef: ChartReference | null;
  event: EventObject | null;
  old: XJogStateChangeState | null;
  new: XJogStateChangeState | null;
};
