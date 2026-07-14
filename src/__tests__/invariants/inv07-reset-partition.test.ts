import { createV6TestRuntime } from '../helpers/v6Runtime';

describe('v6 invariant 07: reset and partition', () => {
  it('clears planes and keyed sequences before exposing a second account', async () => {
    const runtime = createV6TestRuntime();
    await runtime.resetThenSwitchAccount();
    expect(runtime.secondAccountResidue()).toBe(false);
  });
});
