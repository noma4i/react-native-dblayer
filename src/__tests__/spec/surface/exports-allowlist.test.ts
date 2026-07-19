import * as barrel from '../../../index';

describe('public barrel exports', () => {
  it('matches the reviewed runtime export allowlist', () => {
    expect(Object.keys(barrel).sort()).toMatchSnapshot();
  });

  it('does not expose TanStack runtime infrastructure', () => {
    const forbidden = [
      'focusManager',
      'QueryClient',
      'QueryClientProvider',
      'useQuery',
      'useQueryClient',
      'getDbQueryClient',
      'useStableProjection',
      'useStableEntity',
      'useStableSorted',
      'pickEqual',
      'computePhase',
      'computeLoadingState',
      'castNode',
      'castNodes',
      'replayJournal',
      'purgeForeignStorageKeys',
      'emptyIds',
      'dedupeIds',
      'createModelStatusPoller',
      'trimRowsPerScope',
      'resolveStaleTempRows'
    ];

    expect(Object.keys(barrel).filter(name => forbidden.includes(name))).toEqual([]);
  });
});
