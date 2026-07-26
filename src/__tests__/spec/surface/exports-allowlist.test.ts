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
  'intoIf',
  'isIncomingNewer',
  'isTempId',
  'mergeOptimisticMedia',
  'mergeOptimisticSnapshot',
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
  'stringifyNullish',
  'updateWhenRowExists',
  'useMergedScopeRows',
  'waitForRow'
];

describe('public barrel exports', () => {
  it('matches the reviewed runtime export allowlist', () => {
    expect(Object.keys(barrel).sort()).toEqual(runtimeExportAllowlist);
  });
});
