import { createV6TestRuntime } from '../helpers/v6Runtime';

describe('v6 invariant 10: load-more failures', () => {
  it('stores a load-more rejection in query error state', async () => {
    const runtime = createV6TestRuntime();
    await runtime.failLoadMore();
    expect(runtime.queryError()?.message).toBe('transport failure');
  });
});
