import { createSingletonStatics as createPublicSingletonStatics } from '../utils/singletonStatics';
import type { RowId, SingletonStatics } from '../types';

export * from '../index';
export type * from '../types';
export { defineModelRuntime } from '../dsl/defineModelRuntime';

type SingletonUseFind<TStored extends RowId> = (
  id: string | null | undefined,
  options?: { renderKeys?: readonly (keyof TStored & string)[] }
) => TStored | undefined;

/** Accepts both model shapes: the public facade (flat `useFind`) and a runtime model (nested `use.find`). */
type RuntimeSingletonModel<TStored extends RowId> = {
  find(id: string): TStored | undefined;
  update(id: string, updates: Partial<TStored>): boolean | void;
  insert(item: TStored): void;
} & ({ useFind: SingletonUseFind<TStored> } | { use: { find: SingletonUseFind<TStored> } });

export const createSingletonStatics = <TStored extends RowId>(
  model: RuntimeSingletonModel<TStored>,
  recordId: string,
  defaults: TStored
): SingletonStatics<TStored> =>
  createPublicSingletonStatics(
    {
      find: model.find,
      update: model.update,
      insert: model.insert,
      useFind: 'useFind' in model ? model.useFind : model.use.find
    },
    recordId,
    defaults
  );
export { bridgeWindowPagination, useLoadMore, useRelationLoadMore } from '../dsl/pagination';
export {
  isNonArrayRecord,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  isRecord,
  toTimestamp
} from '../utils/normalizeHelpers';
export { noteDataLoss } from '../core/diagnostics';
export { registerResidency, residencySnapshot } from '../core/residency';
export { collectGarbage } from '../core/gc';
export { afterStoreTransaction, OWNED_COLLECTION_LIFETIME, runInStoreTransaction, SyncFeed } from '../core/storeSync';
export { reportSyncError } from '../core/syncError';
export { getCommitBus, getDbQueryClient, getDbRuntimeConfig, purgeForeignStorageKeys } from '../dsl/configure';
export { getApplyRuntime } from '../dsl/configure';
export { createCommitEnvelope } from '../core/apply/commitEnvelope';
export { defineQuery } from '../dsl/defineQuery';
export { bootDb, suspendDb } from '../dsl/lifecycle';
export { compareOrderValues, compareRowsBySpec, createFieldOrderComparator, limitRows, sortModelReadRows, withIdTieBreak } from '../core/ordering';
export { isOrderKey, keyAfter, keyBefore, keyBetween, keysForSequence } from '../core/orderKey';
export { createModelContext } from '../dsl/modelContext';
export { createModelCriteria } from '../dsl/modelCriteria';
export { createModelScopeKeys } from '../dsl/modelScopeKeys';
export { createModelStatusPoller } from '../utils/modelStatusPoller';
export { isTempRowProtectedByModel } from '../dsl/maintenanceRegistry';
export { createProjectionGate } from '../read/projectionGate';
export { incrementalSignature } from '../read/readIdentity';
export { useLiveRead } from '../read/useLiveRead';
export { rowsShallowEqual } from '../utils/rowEquality';
export { isMethodOptimistic, isRespondOptimistic, validateMutationConfig } from '../dsl/mutationConfiguration';
export { correlateIncomingRow, modelHasCorrelators, registerMutationCorrelator } from '../dsl/mutationCorrelation';
export { createMutationResponder } from '../dsl/mutationResponder';
export { registerBootValidation, runBootValidations } from '../dsl/bootValidations';
export { defineIngest, defineModelIngest } from '../dsl/defineIngest';
export { reconcileDetachedOperationsAtBoot } from '../dsl/defineDetachedOperation';
export { isFetchedResult } from '../queries/base/loadingState';
export { registerActiveFetchReaders, refetchActiveFetchReaders, registerMaterializationReconciler, resumeFetchReaders } from '../core/fetch/fetchReaderRegistry';
export { computePhase } from '../queries/base/loadingState';
export { readObjectField } from '../schema/fieldSpec';
export { scalarFieldCodecs } from '../schema/fieldCodec';
export { arraysShallowEqual } from '../utils/arrayEquality';
export { compositeKey, firstCompositeKeyPart } from '../core/serialize';
export { compositeStorageKey } from '../core/serialize';
export { decodePersistence, encodePersistence, jsonRoundTrip } from '../core/persistenceCodec';
export { invalidatePersistedQuery, readPersistedQuery, removePersistedQuery, writePersistedQuery } from '../core/queryPersistence';
export { buildScopeKey, matchesDbWhere } from '../core/compileDbWhere';
export { compileWhereExpression } from '../core/compileWhereExpression';
export { createEntityPlane, createRowCleaner } from '../core/storeEntities';
export { runInApplyBatch } from '../core/storeSync';
export { createCommitBus } from '../core/apply/commitBus';
export { createUpsertResolver, diffTopLevelFields, isSerializedNoop } from '../core/storeUpsertResolver';
export { compileWritePolicies } from '../core/writePolicies';
export { retryDelayMs } from '../core/fetch/retryPolicy';
export { createModelStore, storeScopeCollection } from '../core/store';
export { registerApplyTarget } from '../core/apply/applyTargetRegistry';
export { getApplyTarget } from '../core/apply/applyTargetRegistry';
export { advanceRuntimeGeneration, getOperationState, getRuntimeGeneration } from '../dsl/configure';
export { deriveEffects, hasDependentCascade, readModelRelation, registerRelationHost } from '../core/relations';
export { getInternalModelHandle, getInternalScopeHandle } from '../core/internalHandles';
export { createModelNormalization, readModelField } from '../dsl/modelNormalization';
export { planModelLanding, planModelLandingWithRoot, registerModelLandingHost } from '../dsl/modelLandingGraph';

/**
 * Blanket internal surface for specs. The spec-discipline gate allows relative imports ONLY through
 * this facade (or the public barrel): every internal module a spec exercises is re-exported here,
 * so the allowlist of per-file exceptions stays empty instead of growing.
 */
export * from '../core/schemaManifest';
export * from '../core/serialize';
export * from '../core/persistenceCodec';
export * from '../core/gc';
export * from '../core/apply/commitEnvelope';
export * from '../core/apply/journal';
export * from '../core/apply/transaction';
export * from '../core/apply/commitBus';
export * from '../core/apply/checkpoint';
export * from '../core/fetch/networkState';
export * from '../core/fetch/keyedLocalState';
export * from '../core/planes/operationState';
export * from '../core/planes/storagePlane';
export * from '../core/planes/scopeIndex';
export * from '../core/transport';
export * from '../core/store';
export * from '../core/compileDbWhere';
export * from '../core/fetch/retryPolicy';
export * from '../core/queryPersistence';
export * from '../core/internalHandles';
export * from '../core/invalidationRegistry';
export * from '../core/generationRegistry';
export * from '../core/invariants';
export * from '../core/maintenanceScheduler';
export * from '../core/subscriptionRuntime';
export * from '../dsl/mutationRuntime';
export * from '../dsl/bootValidations';
export * from '../dsl/maintenanceRegistry';
export * from '../utils/modelStatusPoller';
export * from '../utils/modelMaintenance';
export * from '../utils/mmkvStorage';
export { replayJournal, flushPersistence, resetPersistenceRuntime } from '../dsl/configure';
/**
 * Spy seams: the live module namespaces, so a spec can `jest.spyOn` a function AT ITS DEFINITION
 * SITE and intercept internal callers. Spying on a re-exported binding of this facade never
 * reaches those call sites.
 */
export * as diagnosticsModule from '../core/diagnostics';
export * as lifecycleModule from '../dsl/lifecycle';
export * as networkStateModule from '../core/fetch/networkState';
export { createMockMmkv, resetAllMockMmkvStores } from '../../__mocks__/mmkvMockFactory';
export type { UsedMmkvMethods } from '../../__mocks__/mmkvMockFactory';
