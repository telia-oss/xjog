import { createMachine, State } from 'xstate';
import {
  resolveXJogCreateStateChange,
  resolveXJogDeleteStateChange,
  resolveXJogUpdateStateChange,
} from './resolveXJogStateChange';

type Ctx = { count: number; blob: { nested: number[] } };

const machine = createMachine<Ctx>({
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
