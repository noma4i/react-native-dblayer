import fs from 'node:fs';
import path from 'node:path';
import * as barrel from '../../../index';

const runtimeExportAllowlist = [
  'DbProvider',
  'belongsTo',
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
  'gql',
  'hasMany',
  'hasOne',
  'isTempId',
  'modelRef',
  'pickDefined',
  'pickPresent',
  'projectShape',
  'readShape',
  'readShapeOrThrow',
  'references',
  'registerReset',
  'resetRuntime',
  'scalar',
  'setFetchNetworkOnline',
  'useLoadMore',
  'useMergedScopeRows'
];

const assertRemovedModelConfig = (): void => {
  // @ts-expect-error the public model constructor requires a key and the current config
  barrel.defineModel({ id: 'RemovedModel', name: 'RemovedModel', fields: {} });
};
void assertRemovedModelConfig;

describe('public barrel exports', () => {
  it('matches the reviewed runtime export allowlist', () => {
    expect(Object.keys(barrel).sort()).toEqual(runtimeExportAllowlist);
  });

  it('does not export removed model compiler types', () => {
    const entry = fs.readFileSync(path.resolve(__dirname, '../../../index.ts'), 'utf8');
    const removed = [
      'EnsuredRowResult',
      'GcReport',
      'GuardedOrigin',
      'LiveQueryHandle',
      'MaintenanceReport',
      'ModelConfig',
      'MonotonicSpec',
      'NestedKeyPolicy',
      'ScopeCoverage',
      'ScopeHandle',
      'ScopeSpec',
      'ScopeWindowResult',
      'ViewConfig',
      'ViewIncludeModel',
      'ViewIncludeSpec',
      'WindowPaginationBridge',
      'WriteCtx',
      'WriteGroup',
      'WriteOrigin',
      'WritePolicy'
    ];

    for (const name of removed) expect(entry).not.toMatch(new RegExp(`\\b${name}\\b`));
  });
});
