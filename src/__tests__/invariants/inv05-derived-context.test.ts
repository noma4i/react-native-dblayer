import { createV6TestRuntime } from '../helpers/v6Runtime';

describe('v6 invariant 05: derived context', () => {
  it('applies touch and counter cache writes without defeating a later server timestamp', () => {
    const runtime = createV6TestRuntime();
    runtime.applyDerivedThenServer();
    expect(runtime.parentTimestamp()).toBe('2026-07-14T00:00:02.000Z');
    expect(runtime.counter()).toBe(1);
  });
});
