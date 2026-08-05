import fs from 'node:fs';
import path from 'node:path';
import * as barrel from '../../../index';

const runtimeExportAllowlist = [
  'DbProvider',
  'MutationDeliveryUnknownError',
  'belongsTo',
  'configureDb',
  'createIdArrayPatcher',
  'createKeyedArrayPatcher',
  'createNestedObjectPatcher',
  'createSingletonStatics',
  'createThrottledSingleFlight',
  'defineModel',
  'defineShape',
  'f',
  'fromNodes',
  'generateTempId',
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
  'useDbSubscriptions',
  'useLoadMore',
  'useMergedScopeRows'
];

const assertRemovedModelConfig = (): void => {
  // @ts-expect-error the public model constructor requires a key and the current config
  barrel.defineModel({ id: 'RemovedModel', name: 'RemovedModel', fields: {} });
};
void assertRemovedModelConfig;

describe('public barrel exports', () => {
  it('[A13] never builds a model collection from a standalone query response', () => {
    // queryCollectionOptions is the engine's query-owned collection: a model built from it would
    // let one full response own the model and drop bystander rows.
    const walk = (directory: string): string[] =>
      fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(target);
        return /\.tsx?$/.test(entry.name) ? [target] : [];
      });
    const offenders = walk(path.resolve(__dirname, '../../..'))
      .filter(file => fs.readFileSync(file, 'utf8').includes('queryCollectionOptions'))
      .map(file => path.basename(file));
    expect(offenders).toEqual([]);
  });

  it('[I9] [I16] [OP17] [S3] [S6] [S10] [DC2] [ID12] matches the reviewed runtime export allowlist', () => {
    expect(Object.keys(barrel).sort()).toEqual(runtimeExportAllowlist);
  });

  it('[S4] does not export removed model compiler types', () => {
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
