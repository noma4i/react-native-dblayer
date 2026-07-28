import type { EntityState, ModelContext, ModelStore, RelationDecl, ScopeIndex, WriteCtx } from '../types';
import { createModelStore, registerModelStoreFactory } from '../core/store';
import { createScopeIndex } from '../core/planes/scopeIndex';
import { getDbRuntimeConfig, getOperationState, getStoragePrefix } from './configure';

export const createModelContext = <TStored extends { id: string }>(options: {
  modelId: string;
  scopeNames: readonly string[];
  relations: () => Record<string, RelationDecl>;
  applyWriteGate: (previous: TStored, incoming: TStored, ctx: WriteCtx) => TStored;
}): ModelContext<TStored> => {
  type StoredRecord = TStored & Record<string, unknown>;
  let planesRef: { entityState: EntityState<TStored>; scopeIndex: ScopeIndex } | null = null;
  let storeRef: ModelStore<StoredRecord> | null = null;
  let relationCache: Record<string, RelationDecl> | null = null;
  let modelRef: unknown;
  let revision = 0;
  const issuedScopeSequences = new Map<string, number>();
  const planes = () => {
    if (planesRef) return planesRef;
    const runtime = getDbRuntimeConfig();
    const store = createModelStore<StoredRecord>({
      modelId: options.modelId,
      now: () => Date.now(),
      storage: runtime.storage,
      prefix: getStoragePrefix,
      applyWriteGate: options.applyWriteGate as (previous: StoredRecord, incoming: StoredRecord, ctx: WriteCtx) => StoredRecord,
      ownedFields: (rowId, operationId) => getOperationState().ownedFields(options.modelId, rowId, operationId)
    });
    const scopeIndex = createScopeIndex({ modelId: options.modelId, scopeNames: [...options.scopeNames], storage: runtime.storage, prefix: getStoragePrefix });
    store.hydrate();
    scopeIndex.hydrate();
    storeRef = store;
    planesRef = { entityState: store, scopeIndex };
    return planesRef;
  };
  registerModelStoreFactory(options.modelId, () => {
    planes();
    return storeRef!;
  });
  return {
    planes,
    resolvedRelations: () => (relationCache ??= options.relations()),
    revision: () => revision,
    bumpRevision: () => {
      revision += 1;
    },
    issuedScopeSequence: key => issuedScopeSequences.get(key),
    setIssuedScopeSequence: (key, value) => {
      issuedScopeSequences.set(key, value);
    },
    model: <TModel,>(): TModel => modelRef as TModel,
    setModel: model => {
      modelRef = model;
    },
    reset: () => {
      revision += 1;
      issuedScopeSequences.clear();
      planesRef?.scopeIndex.reset();
      storeRef?.reset();
      storeRef?.dispose();
      storeRef = null;
      planesRef = null;
    }
  };
};
