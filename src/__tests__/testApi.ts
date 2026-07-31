import { createSingletonStatics as createPublicSingletonStatics } from '../utils/singletonStatics';
import type { RowId, SingletonStatics } from '../types';

export * from '../index';
export type * from '../types';
export { defineModelRuntime } from '../dsl/defineModelRuntime';

type RuntimeSingletonModel<TStored extends RowId> = {
  find(id: string): TStored | undefined;
  update(id: string, updates: Partial<TStored>): boolean | void;
  insert(item: TStored): void;
  use: {
    find(id: string | null | undefined, options?: { renderKeys?: readonly (keyof TStored & string)[] }): TStored | undefined;
    field?<TField extends keyof TStored & string>(id: string | null | undefined, field: TField): TStored[TField] | undefined;
  };
};

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
      useFind: model.use.find
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
export { collectGarbage } from '../core/gc';
export { afterStoreTransaction, runInStoreTransaction, SyncFeed } from '../core/storeSync';
export { reportSyncError } from '../core/syncError';
export { getCommitBus, getDbQueryClient, getDbRuntimeConfig, purgeForeignStorageKeys } from '../dsl/configure';
export { getApplyRuntime } from '../dsl/configure';
export { createCommitEnvelope } from '../core/apply/commitEnvelope';
export { defineQuery } from '../dsl/defineQuery';
export { suspendDb } from '../dsl/lifecycle';
export { createModelContext } from '../dsl/modelContext';
export { createModelCriteria } from '../dsl/modelCriteria';
export { createModelScopeKeys } from '../dsl/modelScopeKeys';
export { createModelStatusPoller } from '../utils/modelStatusPoller';
export { isTempRowProtectedByModel } from '../dsl/maintenanceRegistry';
export { createProjectionGate } from '../read/projectionGate';
export { createModelReadEngine, limitRows, sortModelReadRows, useIncrementalRead } from '../read/incrementalReadEngine';
export { rowsShallowEqual, useLiveRead } from '../read/useLiveRead';
export { isMethodOptimistic, isRespondOptimistic, validateMutationConfig } from '../dsl/mutationConfiguration';
export { correlateIncomingRow, modelHasCorrelators, registerMutationCorrelator } from '../dsl/mutationCorrelation';
export { createMutationResponder } from '../dsl/mutationResponder';
export { registerBootValidation, runBootValidations } from '../dsl/bootValidations';
export { defineIngest, defineModelIngest } from '../dsl/defineIngest';
export { reconcileDetachedOperationsAtBoot } from '../dsl/defineDetachedOperation';
export { isFetchedResult } from '../queries/base/loadingState';
export { registerActiveFetchReaders, refetchActiveFetchReaders, resumeFetchReaders } from '../core/fetch/fetchReaderRegistry';
export { computePhase } from '../queries/base/loadingState';
export { readObjectField } from '../schema/fieldSpec';
export { scalarFieldCodecs } from '../schema/fieldCodec';
export { arraysShallowEqual } from '../utils/arrayEquality';
export { compositeKey, firstCompositeKeyPart } from '../core/serialize';
export { compositeStorageKey } from '../core/serialize';
export { encodePersistence } from '../core/persistenceCodec';
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
