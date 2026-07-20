import * as barrel from '../../../index';

const runtimeExportAllowlist = [
  'DbProvider',
  'belongsTo',
  'bootDb',
  'collectGarbage',
  'configureDb',
  'createDbSubscriptionEffects',
  'createDbSubscriptionRuntime',
  'createIdArrayPatcher',
  'createKeyedArrayPatcher',
  'createNestedObjectPatcher',
  'createSingletonStatics',
  'createThrottledSingleFlight',
  'defineCommand',
  'defineDbSubscriptionEntry',
  'defineFetch',
  'defineModel',
  'defineShape',
  'f',
  'flushPersistence',
  'generateTempId',
  'getDbTransport',
  'hasMany',
  'hasOne',
  'isIncomingNewer',
  'isTempId',
  'mergeOptimisticMedia',
  'mergeOptimisticSnapshot',
  'mmkvStoragePlane',
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
  'setDbTransport',
  'stringifyNullish',
  'suspendDb',
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
      'resolveStaleTempRows'
    ];

    expect(Object.keys(barrel).filter(name => forbidden.includes(name))).toEqual([]);
  });
});
