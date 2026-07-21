import { resetRuntime } from '../../../index';

// Kill-switch lifecycle contract: an unconfigured runtime is trivially clean.

describe('resetRuntime before configureDb', () => {
  it('is a safe no-op', () => {
    expect(() => resetRuntime()).not.toThrow();
  });
});
