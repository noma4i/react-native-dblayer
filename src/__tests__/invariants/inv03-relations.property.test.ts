import fc from 'fast-check';
import { createV6TestRuntime } from '../helpers/v6Runtime';

describe('v6 invariant 03: relation authority', () => {
  it('limits cascades to explicit ownership destroys and retains referenced rows', () => {
    fc.assert(
      fc.property(fc.boolean(), explicit => {
        const runtime = createV6TestRuntime({ sharedRow: true });
        runtime.reconcile('complete', []);
        expect(runtime.hasSharedRow()).toBe(true);
        runtime.destroyParent(explicit);
        expect(runtime.childWasDestroyed()).toBe(explicit);
      })
    );
  });
});
