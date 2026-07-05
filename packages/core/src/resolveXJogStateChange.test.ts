import { XJogActionTypes } from '@telia-oss/xjog-util';
import { createMachine, State, actions as xstateActions } from 'xstate';
import { ActionTypes } from 'xstate/lib/types';
import {
  mapActions,
  resolveXJogCreateStateChange,
  resolveXJogDeleteStateChange,
  resolveXJogUpdateStateChange,
} from './resolveXJogStateChange';

type Ctx = { count: number; blob: { nested: number[] } };

const machine = createMachine<Ctx>({
  // xstate v4 default; set explicitly to silence the recommendation warning
  // without changing behavior.
  predictableActionArguments: false,
  id: 'test',
  initial: 'a',
  context: { count: 0, blob: { nested: [1, 2, 3] } },
  states: { a: { on: { GO: 'b' } }, b: {} },
});

const ref = { machineId: 'test', chartId: 'c1' };

function stateWith(ctx: Ctx): State<Ctx> {
  return machine.resolveState(State.from('a', ctx));
}

describe('resolveXJogUpdateStateChange', () => {
  it('clones the NEW state context independently', () => {
    const oldState = stateWith({ count: 0, blob: { nested: [1, 2, 3] } });
    const newState = stateWith({ count: 1, blob: { nested: [9] } });

    const change = resolveXJogUpdateStateChange(ref, null, oldState, newState);

    newState.context.blob.nested.push(999);

    expect(change.type).toBe('update');
    expect((change.new?.context as Ctx).count).toBe(1);
    expect((change.new?.context as Ctx).blob.nested).toEqual([9]);
    expect(change.new?.context).not.toBe(newState.context);
  });

  it('passes the OLD state through by reference (caller owns the snapshot)', () => {
    const oldState = stateWith({ count: 0, blob: { nested: [1, 2, 3] } });
    const newState = stateWith({ count: 1, blob: { nested: [9] } });

    const change = resolveXJogUpdateStateChange(ref, null, oldState, newState);

    // old side is NOT re-cloned — it is the caller's snapshot, by reference.
    expect(change.old?.context).toBe(oldState.context);
    expect((change.old?.context as Ctx).count).toBe(0);

    // The alias is live: since the resolver does not clone the old side,
    // a caller-side mutation IS visible through change.old. Callers (XJogChart)
    // therefore must pass an already-isolated snapshot.
    oldState.context.blob.nested.push(999);
    expect((change.old?.context as Ctx).blob.nested).toContain(999);
  });

  it('deep-clones via structuredClone, not a JSON round-trip', () => {
    const structuredCloneSpy = jest.spyOn(globalThis, 'structuredClone');
    const jsonSpy = jest.spyOn(JSON, 'stringify');
    try {
      const oldState = stateWith({ count: 0, blob: { nested: [1] } });
      const newState = stateWith({ count: 1, blob: { nested: [2] } });
      jsonSpy.mockClear(); // ignore any JSON.stringify from State construction above
      resolveXJogUpdateStateChange(ref, null, oldState, newState);
      // New path used: at least the new state's value+context are structuredCloned.
      expect(structuredCloneSpy).toHaveBeenCalled();
      // And the resolver itself no longer round-trips through JSON.
      expect(jsonSpy).not.toHaveBeenCalled();
    } finally {
      structuredCloneSpy.mockRestore();
      jsonSpy.mockRestore();
    }
  });

  it('resolveXJogCreateStateChange returns an independent context copy', () => {
    const state = stateWith({ count: 5, blob: { nested: [1, 2] } });
    const change = resolveXJogCreateStateChange(ref, null, state);
    expect(change.type).toBe('create');
    expect(change.new?.context).not.toBe(state.context);
    expect((change.new?.context as Ctx).blob).not.toBe(state.context.blob);
    expect((change.new?.context as Ctx).blob.nested).toEqual([1, 2]);
  });

  it('resolveXJogDeleteStateChange returns an independent context copy', () => {
    const state = stateWith({ count: 7, blob: { nested: [3] } });
    const change = resolveXJogDeleteStateChange(ref, null, state);
    expect(change.type).toBe('delete');
    expect(change.old?.context).not.toBe(state.context);
    expect((change.old?.context as Ctx).blob.nested).toEqual([3]);
  });
});

describe('mapActions', () => {
  it('maps send actions with sendId, eventType and target', () => {
    const mapped = mapActions([
      {
        type: ActionTypes.Send,
        id: 42,
        _event: { name: 'PING' },
        to: 'someActor',
      },
    ]);
    expect(mapped).toEqual([
      {
        type: ActionTypes.Send,
        sendId: 42,
        eventType: 'PING',
        to: 'someActor',
      },
    ]);
  });

  it('maps cancel actions with sendId', () => {
    const mapped = mapActions([{ type: ActionTypes.Cancel, id: 'timer' }]);
    expect(mapped).toEqual([{ type: ActionTypes.Cancel, sendId: 'timer' }]);
  });

  it('maps start and stop actions with activity id and type', () => {
    const activity = { id: 'poller', type: 'poll' };
    const mapped = mapActions([
      { type: ActionTypes.Start, activity },
      { type: ActionTypes.Stop, activity },
    ]);
    expect(mapped).toEqual([
      { type: ActionTypes.Start, activityId: 'poller', activityType: 'poll' },
      { type: ActionTypes.Stop, activityId: 'poller', activityType: 'poll' },
    ]);
  });

  it('maps the remaining built-in action types to their type only', () => {
    const plainTypes = [
      ActionTypes.Raise,
      ActionTypes.Assign,
      ActionTypes.After,
      ActionTypes.DoneState,
      ActionTypes.DoneInvoke,
      ActionTypes.Log,
      ActionTypes.Init,
      ActionTypes.Invoke,
      ActionTypes.ErrorExecution,
      ActionTypes.ErrorCommunication,
      ActionTypes.ErrorPlatform,
      ActionTypes.ErrorCustom,
      ActionTypes.Update,
      ActionTypes.Pure,
      ActionTypes.Choose,
    ];
    const mapped = mapActions(
      // Payload fields present on the resolved action objects must be dropped.
      plainTypes.map((type) => ({ type, label: 'x', value: () => 'y' })),
    );
    expect(mapped).toEqual(plainTypes.map((type) => ({ type })));
  });

  it('maps custom action types to a runtime xjog.unknown marker', () => {
    const mapped = mapActions([{ type: 'my.customAction' }]);
    expect(XJogActionTypes.Unknown).toBe('xjog.unknown');
    expect(mapped).toEqual([
      { type: XJogActionTypes.Unknown, actionType: 'my.customAction' },
    ]);
  });

  it('maps resolved actions from a real transition', () => {
    const logMachine = createMachine({
      predictableActionArguments: false,
      id: 'log-test',
      initial: 'a',
      states: {
        a: { on: { GO: { target: 'b', actions: xstateActions.log('hello') } } },
        b: {},
      },
    });
    const next = logMachine.transition(logMachine.initialState, 'GO');
    const change = resolveXJogCreateStateChange(ref, null, next);
    expect(change.new?.actions).toEqual([{ type: ActionTypes.Log }]);
  });
});
