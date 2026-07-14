import { createV6TestRuntime } from '../helpers/v6Runtime';

describe('v6 invariant 09: direct mutation rollback', () => {
  it('rolls back run exactly like the hook lifecycle', async () => {
    const runtime = createV6TestRuntime();
    await expect(runtime.failDirectMutation()).rejects.toThrow('transport failure');
    expect(runtime.optimisticRows()).toEqual([]);
  });
});
