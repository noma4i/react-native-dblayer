import * as barrel from '../../../index';

const runtimeExportAllowlist = [
  'DbProvider',
  'belongsTo',
  'bridgeWindowPagination',
  'configureDb',
  'createDbSubscriptionEffects',
  'createDbSubscriptionRuntime',
  'createIdArrayPatcher',
  'createKeyedArrayPatcher',
  'createNestedObjectPatcher',
  'createSingleFlight',
  'createSingletonStatics',
  'createThrottledSingleFlight',
  'defineCommand',
  'defineDbSubscriptionEntry',
  'defineFetch',
  'defineModel',
  'defineShape',
  'f',
  'fromNodes',
  'generateTempId',
  'hasMany',
  'hasOne',
  'isIncomingNewer',
  'isTempId',
  'mergeOptimisticMedia',
  'mergeOptimisticSnapshot',
  'patchWhenRowExists',
  'pickDefined',
  'pickPresent',
  'projectShape',
  'readShape',
  'readShapeOrThrow',
  'reconcileOptimisticRows',
  'references',
  'registerReset',
  'resetRuntime',
  'scope',
  'sinkIf',
  'stringifyNullish',
  'useMergedScopeRows',
  'waitForRow'
];

describe('public barrel exports', () => {
  it('matches the reviewed runtime export allowlist', () => {
    expect(Object.keys(barrel).sort()).toEqual(runtimeExportAllowlist);
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
      'resolveStaleTempRows',
      'getDbTransport',
      'setDbTransport',
      'suspendDb',
      'bootDb',
      'collectGarbage',
      'flushPersistence',
      'mmkvStoragePlane'
    ];

    expect(Object.keys(barrel).filter(name => forbidden.includes(name))).toEqual([]);
  });
});
