import {
  type ChartReference,
  XJogActionTypes,
  type XJogStateChange,
  type XJogStateChangeAction,
  type XJogStateChangeState,
} from '@telia-oss/xjog-util';
import type {
  BaseActionObject,
  EventObject,
  State,
  StateSchema,
  Typestate,
} from 'xstate';
import { ActionTypes } from 'xstate/lib/types';
import { toEventObject } from 'xstate/lib/utils';

/**
 * Minimal slice of an xstate {@link State} that {@link mapState} reads. Callers
 * that snapshot only `value`/`context`/`actions` (e.g. XJogChart's pre-transition
 * state) can pass this instead of a full `State`, so no `as State` cast is needed.
 */
export type XJogStateSnapshot<
  TContext = any,
  TStateSchema extends StateSchema = any,
  TEvent extends EventObject = EventObject,
  TTypeState extends Typestate<TContext> = {
    value: any;
    context: TContext;
  },
> = Pick<
  State<TContext, TEvent, TStateSchema, TTypeState>,
  'value' | 'context' | 'actions'
>;

function mapState<
  TContext = any,
  TStateSchema extends StateSchema = any,
  TEvent extends EventObject = EventObject,
  TTypeState extends Typestate<TContext> = {
    value: any;
    context: TContext;
  },
  TEmitted = any,
>(
  state: XJogStateSnapshot<TContext, TStateSchema, TEvent, TTypeState>,
  // clone=false lets callers skip re-cloning a value they already snapshotted
  // (e.g. XJogChart's pre-transition state). Default clones for safety.
  clone = true,
): XJogStateChangeState {
  return {
    value: clone ? structuredClone(state.value) : state.value,
    context: clone ? structuredClone(state.context) : state.context,
    // ActionObject lost its permissive index signatures in xstate 4.38, so it
    // no longer satisfies BaseActionObject structurally; at runtime the
    // resolved actions are the same plain objects they were in 4.26.
    actions: mapActions(state.actions as unknown as BaseActionObject[]),
  };
}

export function resolveXJogCreateStateChange<
  TContext = any,
  TStateSchema extends StateSchema = any,
  TEvent extends EventObject = EventObject,
  TTypeState extends Typestate<TContext> = {
    value: any;
    context: TContext;
  },
  TEmitted = any,
>(
  ref: ChartReference,
  parentRef: ChartReference | null,
  state: State<TContext, TEvent, TStateSchema, TTypeState>,
): XJogStateChange {
  return {
    type: 'create',
    ref,
    parentRef,
    event: toEventObject(state.event),
    old: null,
    new: mapState(state),
  };
}

export function resolveXJogUpdateStateChange<
  TContext = any,
  TStateSchema extends StateSchema = any,
  TEvent extends EventObject = EventObject,
  TTypeState extends Typestate<TContext> = {
    value: any;
    context: TContext;
  },
  TEmitted = any,
>(
  ref: ChartReference,
  parentRef: ChartReference | null,
  previousState: XJogStateSnapshot<TContext, TStateSchema, TEvent, TTypeState>,
  nextState: State<TContext, TEvent, TStateSchema, TTypeState>,
): XJogStateChange {
  return {
    type: 'update',
    ref,
    parentRef,
    event: toEventObject(nextState.event),
    old: mapState(previousState, false),
    new: mapState(nextState),
  };
}

export function resolveXJogDeleteStateChange<
  TContext = any,
  TStateSchema extends StateSchema = any,
  TEvent extends EventObject = EventObject,
  TTypeState extends Typestate<TContext> = {
    value: any;
    context: TContext;
  },
  TEmitted = any,
>(
  ref: ChartReference,
  parentRef: ChartReference | null,
  lastState: State<TContext, TEvent, TStateSchema, TTypeState>,
): XJogStateChange {
  return {
    type: 'delete',
    ref,
    parentRef,
    event: null,
    old: mapState(lastState),
    new: null,
  };
}

export function mapActions(
  actions: BaseActionObject[],
): XJogStateChangeAction[] {
  // @ts-expect-error
  return actions.map((action) => {
    switch (action.type) {
      case ActionTypes.Send:
        return {
          type: ActionTypes.Send,
          sendId: action.id,
          eventType: action._event.name,
          to: action.to,
        };

      case ActionTypes.Cancel:
        return {
          type: ActionTypes.Cancel,
          sendId: action.id,
        };

      case ActionTypes.Start:
        return {
          type: ActionTypes.Start,
          activityId: action.activity.id,
          activityType: action.activity.type,
        };

      case ActionTypes.Stop:
        return {
          type: ActionTypes.Stop,
          activityId: action.activity.id,
          activityType: action.activity.type,
        };

      case ActionTypes.Assign:
      case ActionTypes.Raise:
      case ActionTypes.After:
      case ActionTypes.DoneState:
      case ActionTypes.DoneInvoke:
      case ActionTypes.Log:
      case ActionTypes.Init:
      case ActionTypes.Invoke:
      case ActionTypes.ErrorExecution:
      case ActionTypes.ErrorCommunication:
      case ActionTypes.ErrorPlatform:
      case ActionTypes.ErrorCustom:
      case ActionTypes.Update:
      case ActionTypes.Pure:
      case ActionTypes.Choose:
        return {
          type: action.type,
        };

      default:
        // return { type: XJogActionTypes.Unknown, actionType: action.type };
        return { type: 'xjog.unknown', actionType: action.type };
    }
  });
}
