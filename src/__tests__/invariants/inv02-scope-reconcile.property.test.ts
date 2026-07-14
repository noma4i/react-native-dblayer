import fc from 'fast-check';
import { createV6TestRuntime } from '../helpers/v6Runtime';

describe('v6 invariant 02: scope reconcile', () => {
  it('only detaches missing membership for complete coverage', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('complete', 'page', 'delta'),
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 8 }),
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 8 }),
        (coverage, current, incoming) => {
          const runtime = createV6TestRuntime({ current });
          runtime.reconcile(coverage, incoming);
          expect(runtime.scopeIds()).toEqual(coverage === 'complete' ? incoming : [...current, ...incoming.filter(id => !current.includes(id))]);
          expect(runtime.destroyedIds()).toEqual([]);
        }
      )
    );
  });
});
