import { createV6TestRuntime } from '../helpers/v6Runtime';

describe('v6 invariant 06: semantic commit bus', () => {
  it('publishes one batch and excludes unrelated field projections', () => {
    const runtime = createV6TestRuntime();
    runtime.applyManyRows();
    expect(runtime.commitBatchCount()).toBe(1);
    expect(runtime.unrelatedProjectionNotifications()).toBe(0);
  });
});
