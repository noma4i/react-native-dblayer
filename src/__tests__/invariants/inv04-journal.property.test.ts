import fc from 'fast-check';
import { createV6TestRuntime } from '../helpers/v6Runtime';

describe('v6 invariant 04: journal replay', () => {
  it('converges exactly once after every durable-commit interruption point', () => {
    fc.assert(
      fc.property(fc.constantFrom('before', 'during', 'after'), interruption => {
        const runtime = createV6TestRuntime();
        const expected = runtime.applyThenRestart(interruption);
        expect(runtime.snapshot()).toEqual(expected);
      })
    );
  });
});
