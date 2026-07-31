import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const specRoot = path.resolve(__dirname, '..');
const publicBarrel = path.resolve(specRoot, '../../index.ts');
const incrementalEngineSpec = path.resolve(specRoot, 'rerender/r04-incremental-read-engine.test.ts');
const incrementalEngineSource = path.resolve(specRoot, '../../read/incrementalReadEngine.ts');

/**
 * `bootDb`/`collectGarbage`/`flushPersistence`/`registerBootValidation` are internal to
 * `DbProvider` and not on the public barrel (see index.ts); these specs exercise boot/GC/
 * persistence behavior directly and must reach past the barrel for it, the same way
 * `incrementalEngineSpec` reaches `incrementalReadEngine.ts`.
 */
const internalAccessExceptions: ReadonlyArray<{ spec: string; source: string }> = [
  { spec: path.resolve(specRoot, 'consumer/c-failure-contract.test.tsx'), source: path.resolve(specRoot, '../../dsl/lifecycle.ts') },
  { spec: path.resolve(specRoot, 'consumer/c-failure-contract.test.tsx'), source: path.resolve(specRoot, '../../dsl/configure.ts') },
  { spec: path.resolve(specRoot, 'consumer/c-gc-reset-and-subscription-utils.test.ts'), source: path.resolve(specRoot, '../../core/gc.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-gc-store-projection.test.tsx'), source: path.resolve(specRoot, '../../core/gc.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-generation-registry.test.ts'), source: path.resolve(specRoot, '../../core/generationRegistry.ts') },
  { spec: path.resolve(specRoot, 'consumer/c-freshness-survival.test.tsx'), source: path.resolve(specRoot, '../../core/gc.ts') },
  { spec: path.resolve(specRoot, 'consumer/c-freshness-survival.test.tsx'), source: path.resolve(specRoot, '../../core/fetch/fetchReaderRegistry.ts') },
  { spec: path.resolve(specRoot, 'consumer/c-freshness-survival.test.tsx'), source: path.resolve(specRoot, '../../core/serialize.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-durable-temp-protection.test.tsx'), source: path.resolve(specRoot, '../../core/gc.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-durable-temp-protection.test.tsx'), source: path.resolve(specRoot, '../../dsl/mutationRuntime.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-durable-temp-protection.test.tsx'), source: path.resolve(specRoot, '../../dsl/maintenanceRegistry.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-reset-definition-registries.test.tsx'), source: path.resolve(specRoot, '../../dsl/bootValidations.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-reset-definition-registries.test.tsx'), source: path.resolve(specRoot, '../../core/fetch/networkState.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-subscription-correctness.test.tsx'), source: path.resolve(specRoot, '../../core/fetch/networkState.ts') },
  { spec: path.resolve(specRoot, 'utils/u03-keyed-local-state.test.ts'), source: path.resolve(specRoot, '../../core/fetch/keyedLocalState.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-reset-definition-registries.test.tsx'), source: path.resolve(specRoot, '../../core/subscriptionRuntime.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-reset-definition-registries.test.tsx'), source: path.resolve(specRoot, '../../core/invalidationRegistry.ts') },
  { spec: path.resolve(specRoot, 'consumer/c07-maintenance-trim.test.tsx'), source: path.resolve(specRoot, '../../dsl/lifecycle.ts') },
  { spec: path.resolve(specRoot, 'consumer/c07-maintenance-trim.test.tsx'), source: path.resolve(specRoot, '../../core/gc.ts') },
  { spec: path.resolve(specRoot, 'consumer/c07-maintenance-trim.test.tsx'), source: path.resolve(specRoot, '../../dsl/mutationRuntime.ts') },
  { spec: path.resolve(specRoot, 'integrity/i03-dedupe.test.ts'), source: path.resolve(specRoot, '../../dsl/lifecycle.ts') },
  { spec: path.resolve(specRoot, 'integrity/i03-dedupe.test.ts'), source: path.resolve(specRoot, '../../dsl/configure.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-reset-scope-registry.test.tsx'), source: path.resolve(specRoot, '../../dsl/configure.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-manifest.test.tsx'), source: path.resolve(specRoot, '../../core/schemaManifest.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-manifest.test.tsx'), source: path.resolve(specRoot, '../../dsl/lifecycle.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-recovery.test.tsx'), source: path.resolve(specRoot, '../../core/schemaManifest.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-recovery.test.tsx'), source: path.resolve(specRoot, '../../core/persistenceCodec.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-serialize-identity.test.ts'), source: path.resolve(specRoot, '../../core/serialize.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-order-key.test.ts'), source: path.resolve(specRoot, '../../core/orderKey.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-store-contract.test.ts'), source: path.resolve(specRoot, '../../core/orderKey.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-order-key.test.ts'), source: path.resolve(specRoot, '../../core/serialize.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-journal-corruption.test.ts'), source: path.resolve(specRoot, '../../core/apply/journal.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-journal-corruption.test.ts'), source: path.resolve(specRoot, '../../core/persistenceCodec.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-journal-corruption.test.ts'), source: path.resolve(specRoot, '../../types') },
  { spec: path.resolve(specRoot, 'integrity/i-checkpoint-scheduler.test.ts'), source: path.resolve(specRoot, '../../core/apply/checkpoint.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-checkpoint-scheduler.test.ts'), source: path.resolve(specRoot, '../../types') },
  { spec: path.resolve(specRoot, 'integrity/i-apply-batch.test.ts'), source: path.resolve(specRoot, '../../core/apply/transaction.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-apply-batch.test.ts'), source: path.resolve(specRoot, '../../core/apply/commitEnvelope.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-apply-batch.test.ts'), source: path.resolve(specRoot, '../../core/apply/applyTargetRegistry.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-apply-recovery.test.ts'), source: path.resolve(specRoot, '../../core/apply/commitEnvelope.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-apply-recovery.test.ts'), source: path.resolve(specRoot, '../../core/apply/applyTargetRegistry.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-apply-recovery.test.ts'), source: path.resolve(specRoot, '../../core/apply/journal.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-apply-recovery.test.ts'), source: path.resolve(specRoot, '../../dsl/configure.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-apply-batch.test.ts'), source: path.resolve(specRoot, '../../core/apply/journal.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-apply-batch.test.ts'), source: path.resolve(specRoot, '../../core/persistenceCodec.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-operation-ledger.test.ts'), source: path.resolve(specRoot, '../../core/planes/operationState.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-operation-ledger.test.ts'), source: path.resolve(specRoot, '../../core/persistenceCodec.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-scope-key.test.ts'), source: path.resolve(specRoot, '../../core/compileDbWhere.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-operation-ledger.test.ts'), source: path.resolve(specRoot, '../../types') },
  { spec: path.resolve(specRoot, 'integrity/i-apply-batch.test.ts'), source: path.resolve(specRoot, '../../core/apply/commitBus.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-apply-batch.test.ts'), source: path.resolve(specRoot, '../../types') },
  { spec: path.resolve(specRoot, 'integrity/i-once-keys-corruption.test.ts'), source: path.resolve(specRoot, '../../core/schemaManifest.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-once-keys-corruption.test.ts'), source: path.resolve(specRoot, '../../core/persistenceCodec.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-once-keys-corruption.test.ts'), source: path.resolve(specRoot, '../../dsl/lifecycle.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-recovery.test.tsx'), source: path.resolve(specRoot, '../../dsl/lifecycle.ts') },
  { spec: path.resolve(specRoot, 'consumer/c07-maintenance-trim.test.tsx'), source: path.resolve(specRoot, '../../core/schemaManifest.ts') },
  { spec: path.resolve(specRoot, 'consumer/c-failure-contract.test.tsx'), source: path.resolve(specRoot, '../../core/schemaManifest.ts') },
  { spec: path.resolve(specRoot, 'sufficiency/s03-provider-boot.test.tsx'), source: path.resolve(specRoot, '../../core/schemaManifest.ts') },
  { spec: path.resolve(specRoot, 'sufficiency/s03-provider-boot.test.tsx'), source: path.resolve(specRoot, '../../dsl/lifecycle.ts') },
  { spec: path.resolve(specRoot, 'sufficiency/s07-pending-flag.test.tsx'), source: path.resolve(specRoot, '../../core/schemaManifest.ts') },
  { spec: path.resolve(specRoot, 'sufficiency/s07-pending-flag.test.tsx'), source: path.resolve(specRoot, '../../core/persistenceCodec.ts') },
  { spec: path.resolve(specRoot, 'consumer/c-ensured-row.test.tsx'), source: path.resolve(specRoot, '../../core/schemaManifest.ts') },
  { spec: path.resolve(specRoot, 'perf/p04-app-scale-lifecycle.test.tsx'), source: path.resolve(specRoot, '../../core/schemaManifest.ts') },
  { spec: path.resolve(specRoot, 'integrity/i03-dedupe.test.ts'), source: path.resolve(specRoot, '../../core/schemaManifest.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-fault-harness.test.tsx'), source: path.resolve(specRoot, '../../core/schemaManifest.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-fault-harness.test.tsx'), source: path.resolve(specRoot, '../../core/persistenceCodec.ts') },
  { spec: path.resolve(specRoot, 'sufficiency/s09-seed.test.tsx'), source: path.resolve(specRoot, '../../core/schemaManifest.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-fault-harness.test.tsx'), source: path.resolve(specRoot, '../../dsl/configure.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-fault-harness.test.tsx'), source: path.resolve(specRoot, '../../core/apply/transaction.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-fault-harness.test.tsx'), source: path.resolve(specRoot, '../../core/apply/commitEnvelope.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-fault-harness.test.tsx'), source: path.resolve(specRoot, '../../core/apply/journal.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-fault-harness.test.tsx'), source: path.resolve(specRoot, '../../core/apply/commitBus.ts') },
  { spec: path.resolve(specRoot, 'sufficiency/s03-provider-boot.test.tsx'), source: path.resolve(specRoot, '../../dsl/bootValidations.ts') },
  { spec: path.resolve(specRoot, 'sufficiency/s07-pending-flag.test.tsx'), source: path.resolve(specRoot, '../../dsl/lifecycle.ts') },
  { spec: path.resolve(specRoot, 'perf/p05-pending-index-scale.test.tsx'), source: path.resolve(specRoot, '../../dsl/configure.ts') },
  { spec: path.resolve(specRoot, 'perf/p05-pending-index-scale.test.tsx'), source: path.resolve(specRoot, '../../types') },
  { spec: path.resolve(specRoot, 'perf/p06-large-scope-churn.test.tsx'), source: path.resolve(specRoot, '../../core/serialize.ts') },
  { spec: path.resolve(specRoot, 'appshape/app-loss.test.tsx'), source: path.resolve(specRoot, '../../dsl/lifecycle.ts') },
  { spec: path.resolve(specRoot, 'appshape/app-loss.test.tsx'), source: path.resolve(specRoot, '../../dsl/configure.ts') },
  { spec: path.resolve(specRoot, 'appshape/app-loss.test.tsx'), source: path.resolve(specRoot, '../../core/schemaManifest.ts') },
  { spec: path.resolve(specRoot, 'appshape/app-loss.test.tsx'), source: path.resolve(specRoot, '../../core/serialize.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-effects-acceptance.test.tsx'), source: path.resolve(specRoot, '../../core/apply/applyTargetRegistry.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-effects-acceptance.test.tsx'), source: path.resolve(specRoot, '../../dsl/configure.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-effects-acceptance.test.tsx'), source: path.resolve(specRoot, '../../dsl/lifecycle.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-durable-freshness.test.tsx'), source: path.resolve(specRoot, '../../dsl/lifecycle.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-query-persistence.test.ts'), source: path.resolve(specRoot, '../../core/queryPersistence.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-effects-acceptance.test.tsx'), source: path.resolve(specRoot, '../../core/schemaManifest.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-ledger-lifecycle.test.tsx'), source: path.resolve(specRoot, '../../core/gc.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-ledger-lifecycle.test.tsx'), source: path.resolve(specRoot, '../../core/planes/operationState.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-ledger-lifecycle.test.tsx'), source: path.resolve(specRoot, '../../types') },
  { spec: path.resolve(specRoot, 'integrity/i-subscription-correctness.test.tsx'), source: path.resolve(specRoot, '../../core/subscriptionRuntime.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-poller-dedup-scheduler.test.ts'), source: path.resolve(specRoot, '../../utils/modelStatusPoller.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-maintenance-scheduler.test.tsx'), source: path.resolve(specRoot, '../../core/gc.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-maintenance-scheduler.test.tsx'), source: path.resolve(specRoot, '../../core/maintenanceScheduler.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-account-switch-integrity.test.tsx'), source: path.resolve(specRoot, '../../dsl/configure.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-apply-honesty.test.tsx'), source: path.resolve(specRoot, '../../dsl/configure.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-apply-honesty.test.tsx'), source: path.resolve(specRoot, '../../core/apply/commitEnvelope.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-apply-honesty.test.tsx'), source: path.resolve(specRoot, '../../core/apply/journal.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-apply-honesty.test.tsx'), source: path.resolve(specRoot, '../../core/persistenceCodec.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-apply-honesty.test.tsx'), source: path.resolve(specRoot, '../../dsl/lifecycle.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-apply-honesty.test.tsx'), source: path.resolve(specRoot, '../../core/schemaManifest.ts') },
  { spec: path.resolve(specRoot, 'consumer/c-row-waiters.test.ts'), source: path.resolve(specRoot, '../../dsl/configure.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-schema-fingerprint-order.test.ts'), source: path.resolve(specRoot, '../../core/schemaManifest.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-schema-fingerprint-order.test.ts'), source: path.resolve(specRoot, '../../types') },
  { spec: path.resolve(specRoot, 'integrity/i-manifest.test.tsx'), source: path.resolve(specRoot, '../../types') },
  { spec: path.resolve(specRoot, 'integrity/i-schema-fingerprint-order.test.ts'), source: path.resolve(specRoot, '../../core/serialize.ts') },
  { spec: path.resolve(specRoot, 'utils/u02-resolve-stale-temp-rows.test.ts'), source: path.resolve(specRoot, '../../utils/modelMaintenance.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-mmkv-storage-contract.test.ts'), source: path.resolve(specRoot, '../../dsl/lifecycle.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-mmkv-storage-contract.test.ts'), source: path.resolve(specRoot, '../../core/planes/storagePlane.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-mmkv-storage-contract.test.ts'), source: path.resolve(specRoot, '../../utils/mmkvStorage.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-mmkv-storage-contract.test.ts'), source: path.resolve(specRoot, '../../../__mocks__/mmkvMockFactory.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-transport-not-configured.test.ts'), source: path.resolve(specRoot, '../../core/transport.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-internal-handle-guards.test.ts'), source: path.resolve(specRoot, '../../core/internalHandles.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-detached-operations.test.tsx'), source: path.resolve(specRoot, '../../core/gc.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-detached-operations.test.tsx'), source: path.resolve(specRoot, '../../core/schemaManifest.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-detached-operations.test.tsx'), source: path.resolve(specRoot, '../../dsl/configure.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-mutation-atomicity.test.tsx'), source: path.resolve(specRoot, '../../dsl/configure.ts') },
  { spec: path.resolve(specRoot, 'rerender/r05-read-path-render-budget.test.tsx'), source: path.resolve(specRoot, '../../dsl/configure.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-commit-envelope-planning.test.tsx'), source: path.resolve(specRoot, '../../core/apply/commitEnvelope.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-commit-envelope-planning.test.tsx'), source: path.resolve(specRoot, '../../core/serialize.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-commit-envelope-planning.test.tsx'), source: path.resolve(specRoot, '../../core/internalHandles.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-commit-envelope-planning.test.tsx'), source: path.resolve(specRoot, '../../dsl/configure.ts') },
  { spec: path.resolve(specRoot, 'perf/p05-pending-index-scale.test.tsx'), source: path.resolve(specRoot, '../../core/apply/commitEnvelope.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-detached-operations.test.tsx'), source: path.resolve(specRoot, '../../dsl/lifecycle.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-write-policies.test.ts'), source: path.resolve(specRoot, '../../core/invariants.ts') },
  { spec: path.resolve(specRoot, 'integrity/i01-retry-policy.test.ts'), source: path.resolve(specRoot, '../../core/fetch/retryPolicy.ts') },
  { spec: path.resolve(specRoot, 'integrity/i06-ordering-laws.test.ts'), source: path.resolve(specRoot, '../../core/ordering.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-scope-order-reset.test.tsx'), source: path.resolve(specRoot, '../../core/planes/scopeIndex.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-scope-order-reset.test.tsx'), source: path.resolve(specRoot, '../../core/serialize.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-recovery.test.tsx'), source: path.resolve(specRoot, '../../core/serialize.ts') },
  { spec: path.resolve(specRoot, 'integrity/i03-dedupe.test.ts'), source: path.resolve(specRoot, '../../core/serialize.ts') },
  { spec: path.resolve(specRoot, 'helpers/harness.ts'), source: path.resolve(specRoot, '../../core/fetch/networkState.ts') },
  { spec: path.resolve(specRoot, 'helpers/harness.ts'), source: path.resolve(specRoot, '../../core/serialize.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-store-contract.test.ts'), source: path.resolve(specRoot, '../../core/store.ts') },
  { spec: path.resolve(specRoot, 'integrity/i-apply-batch.test.ts'), source: path.resolve(specRoot, '../../core/store.ts') }
];

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.tsx?$/.test(entry.name) ? [target] : [];
  });

const resolvedImport = (file: string, specifier: string): string => {
  const base = path.resolve(path.dirname(file), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')].find(candidate => fs.existsSync(candidate)) ?? base;
};

const relativeImports = (file: string): string[] => {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports.filter(specifier => specifier.startsWith('.'));
};

describe('spec import discipline', () => {
  it('allows source imports only through the public barrel', () => {
    const compilerTestBarrel = path.resolve(specRoot, '../testApi.ts');
    const violations = sourceFiles(specRoot).flatMap(file =>
      relativeImports(file).flatMap(specifier => {
        const target = resolvedImport(file, specifier);
        const staysInSpec = !path.relative(specRoot, target).startsWith('..');
        const isIncrementalEngineContract = file === incrementalEngineSpec && target === incrementalEngineSource;
        const isInternalAccessException = internalAccessExceptions.some(exception => file === exception.spec && target === exception.source);
        return staysInSpec || target === publicBarrel || target === compilerTestBarrel || isIncrementalEngineContract || isInternalAccessException
          ? []
          : [`${path.relative(specRoot, file)} -> ${specifier}`];
      })
    );

    expect(violations).toEqual([]);
  });

  it('keeps perf and appshape gates free of wall-clock measurements', () => {
    const gateFiles = ['perf', 'appshape'].flatMap(directory => sourceFiles(path.join(specRoot, directory)));

    for (const file of gateFiles) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source).not.toMatch(/performance\.now/);
      expect(source).not.toMatch(/\bmedian\b/);
    }
  });

  it('keeps nullable scalar conversion inside the shared field codec', () => {
    const sourceRoot = path.resolve(specRoot, '../..');
    const violations = sourceFiles(sourceRoot)
      .filter(file => !file.includes(`${path.sep}__tests__${path.sep}`))
      .flatMap(file => (/\breadNullable[A-Z]/.test(fs.readFileSync(file, 'utf8')) ? [path.relative(sourceRoot, file)] : []));

    expect(violations).toEqual([]);
  });
});
