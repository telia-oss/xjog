import { createMachine, State } from 'xstate';
import { resolveXJogUpdateStateChange } from './resolveXJogStateChange';

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
  it('emits independent deep copies of old and new context', () => {
    const oldState = stateWith({ count: 0, blob: { nested: [1, 2, 3] } });
    const newState = stateWith({ count: 1, blob: { nested: [9] } });
    const change = resolveXJogUpdateStateChange(ref, null, oldState, newState);
    (oldState.context.blob.nested as number[]).push(999);
    (newState.context.blob.nested as number[]).push(999);
    expect(change.type).toBe('update');
    expect((change.old?.context as Ctx).count).toBe(0);
    expect((change.old?.context as Ctx).blob.nested).toEqual([1, 2, 3]);
    expect((change.new?.context as Ctx).count).toBe(1);
    expect((change.new?.context as Ctx).blob.nested).toEqual([9]);
  });

  it('does not round-trip context through JSON.stringify', () => {
    const spy = jest.spyOn(JSON, 'stringify');
    const oldState = stateWith({ count: 0, blob: { nested: [1] } });
    const newState = stateWith({ count: 1, blob: { nested: [2] } });
    resolveXJogUpdateStateChange(ref, null, oldState, newState);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
