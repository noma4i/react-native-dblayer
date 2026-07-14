import fc from 'fast-check';
import { createV6TestRuntime } from '../helpers/v6Runtime';

describe('v6 invariant 01: interleavings', () => {
  it('preserves tombstones, post-capture writes, counters, and operation closure', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('initial', 'page', 'sub-upsert', 'sub-destroy', 'optimistic', 'commit', 'rollback', 're-delivery'), { minLength: 1, maxLength: 80 }),
        operations => {
          const runtime = createV6TestRuntime();
          runtime.run([...operations, 'commit']);
          expect(runtime.assertInvariants()).toEqual([]);
        }
      )
    );
  });
});
