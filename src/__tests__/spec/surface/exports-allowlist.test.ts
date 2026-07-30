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
  'isTempId',
  'pickDefined',
  'pickPresent',
  'projectShape',
  'readId',
  'readShape',
  'readShapeOrThrow',
  'references',
  'registerReset',
  'resetRuntime',
  'setFetchNetworkOnline',
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
