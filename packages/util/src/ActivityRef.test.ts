import { isActivityRef } from './ActivityRef';

describe('isActivityRef', () => {
  const validRef = {
    id: 'activity-1',
    owner: { machineId: 'machine', chartId: 'chart' },
    autoForward: false,
    send: () => undefined,
    subscribe: () => ({ unsubscribe: () => undefined }),
  };

  it('accepts a valid activity ref', () => {
    expect(isActivityRef(validRef)).toBe(true);
  });

  it('accepts a valid activity ref with null owner', () => {
    expect(isActivityRef({ ...validRef, owner: null })).toBe(true);
  });

  // Regression: the guard used `&&` instead of `||`, so null and undefined
  // fell through to property access and threw a TypeError
  it('rejects null and undefined without throwing', () => {
    expect(isActivityRef(null)).toBe(false);
    expect(isActivityRef(undefined)).toBe(false);
  });

  it('rejects primitives without throwing', () => {
    expect(isActivityRef(5)).toBe(false);
    expect(isActivityRef('activity')).toBe(false);
    expect(isActivityRef(true)).toBe(false);
  });

  it('rejects objects missing required fields', () => {
    expect(isActivityRef({})).toBe(false);
    expect(isActivityRef({ id: 'x' })).toBe(false);
    expect(isActivityRef({ ...validRef, send: 'not a function' })).toBe(false);
    expect(isActivityRef({ ...validRef, owner: 'not a ref' })).toBe(false);
  });
});
