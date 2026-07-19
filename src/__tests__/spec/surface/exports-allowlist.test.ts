import * as barrel from '../../../index';

describe('public barrel exports', () => {
  it('matches the reviewed runtime export allowlist', () => {
    expect(Object.keys(barrel).sort()).toMatchSnapshot();
  });

  it('does not expose TanStack runtime infrastructure', () => {
    const forbidden = ['focusManager', 'QueryClient', 'QueryClientProvider', 'useQuery', 'useQueryClient', 'getDbQueryClient'];

    expect(Object.keys(barrel)).not.toEqual(expect.arrayContaining(forbidden));
  });

  // GATE-PENDING(G11): Remove low-level compatibility helpers from the public barrel.
  test.failing('does not expose infrastructure or low-level helpers', () => {
    const forbidden = [
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
