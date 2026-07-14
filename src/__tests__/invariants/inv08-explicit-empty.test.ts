import { createV6TestRuntime } from '../helpers/v6Runtime';

describe('v6 invariant 08: explicit empty', () => {
  it('clears complete membership for an explicit empty response', () => {
    const runtime = createV6TestRuntime({ current: ['a', 'b'] });
    runtime.reconcile('complete', []);
    expect(runtime.scopeIds()).toEqual([]);
  });
});
