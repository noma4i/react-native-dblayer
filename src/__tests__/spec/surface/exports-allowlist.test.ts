import * as barrel from '../../../index';

describe('public barrel exports', () => {
  it('matches the reviewed runtime export allowlist', () => {
    expect(Object.keys(barrel).sort()).toMatchSnapshot();
  });

  // GATE-PENDING(G5/G11): Remove infrastructure and low-level compatibility helpers from the public barrel.
  test.failing('does not expose infrastructure or low-level helpers', () => {
    const forbidden = [
      'focusManager',
      'QueryClient',
      'QueryClientProvider',
      'useQuery',
      'useQueryClient',
      'castNode',
      'castNodes',
      'useStableProjection',
      'useStableEntity',
      'useStableSorted',
      'pickEqual',
      'computePhase',
      'computeLoadingState'
    ];

    expect(Object.keys(barrel)).not.toEqual(expect.arrayContaining(forbidden));
  });
});
