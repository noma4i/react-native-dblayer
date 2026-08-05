import type { EntityState, ModelContext, ModelRevisionOwner, ModelStore, RelationDecl, ScopeIndex, WriteCtx } from '../types';
import { noteCausalAdmissionDrop } from '../core/diagnostics';
import { createModelStore, registerModelStoreFactory } from '../core/store';
import { createScopeIndex } from '../core/planes/scopeIndex';
import { getDbRuntimeConfig, getOperationState, getStoragePrefix } from './configure';

export const createModelContext = <TStored extends { id: string }>(options: {
  modelId: string;
  scopeNames: readonly string[];
  relations: () => Record<string, RelationDecl>;
  applyWriteGate: (previous: TStored, incoming: TStored, ctx: WriteCtx) => TStored;
}): ModelContext<TStored> => {
  let planesRef: { entityState: EntityState<TStored>; scopeIndex: ScopeIndex } | null = null;
  let storeRef: ModelStore<TStored & Record<string, unknown>> | null = null;
  let relationCache: Record<string, RelationDecl> | null = null;
  let modelRef: unknown;
  const issuedScopeSequences = new Map<string, number>();
  const rowEpochs = new Map<string, number>();
  const existenceEpochs = new Map<string, number>();
  const fieldEpochs = new Map<string, Map<string, number>>();
  let pendingEpoch: number | null = null;
  let pendingRows = new Set<string>();
  let pendingExistence = new Set<string>();
  let pendingFields = new Map<string, Set<string>>();
  const changedAfter = (epochs: Map<string, number>, id: string, baseRevision: number): boolean => (epochs.get(id) ?? 0) > baseRevision;
  const revisions: ModelRevisionOwner<TStored> = {
    admitRow: (incoming, previous, baseRevision) => {
      if (baseRevision === undefined) return incoming;
      if (changedAfter(existenceEpochs, incoming.id, baseRevision)) {
        noteCausalAdmissionDrop();
        return null;
      }
      if (!previous) {
        if (!changedAfter(rowEpochs, incoming.id, baseRevision)) return incoming;
        noteCausalAdmissionDrop();
        return null;
      }
      const epochs = fieldEpochs.get(incoming.id);
      if (!epochs) return incoming;
      const admitted = { ...incoming };
      let evictedFields = 0;
      for (const field of Object.keys(incoming)) {
        if (field === 'id' || (epochs.get(field) ?? 0) <= baseRevision) continue;
        evictedFields += 1;
        if (Object.hasOwn(previous, field)) admitted[field as keyof TStored] = previous[field as keyof TStored];
        else delete admitted[field as keyof TStored];
      }
      if (evictedFields > 0) noteCausalAdmissionDrop();
      return admitted;
    },
    admitPatch: (id, patch, remove, previous, baseRevision) => {
      if (!previous) return null;
      if (baseRevision === undefined) return { patch, remove: [...remove] };
      if (changedAfter(existenceEpochs, id, baseRevision)) {
        noteCausalAdmissionDrop();
        return null;
      }
      const epochs = fieldEpochs.get(id);
      if (!epochs) return { patch, remove: [...remove] };
      const admittedPatch = Object.fromEntries(Object.entries(patch).filter(([field]) => (epochs.get(field) ?? 0) <= baseRevision));
      const admittedRemove = remove.filter(field => (epochs.get(field) ?? 0) <= baseRevision);
      if (Object.keys(admittedPatch).length < Object.keys(patch).length || admittedRemove.length < remove.length) noteCausalAdmissionDrop();
      return Object.keys(admittedPatch).length > 0 || admittedRemove.length > 0 ? { patch: admittedPatch, remove: admittedRemove } : null;
    },
    admitDestroy: (id, baseRevision) =>
      baseRevision === undefined || (!changedAfter(rowEpochs, id, baseRevision) && !changedAfter(existenceEpochs, id, baseRevision)),
    beginApply: epoch => {
      if (pendingEpoch !== null) throw new Error(`${options.modelId}: revision apply already active`);
      pendingEpoch = epoch;
      pendingRows = new Set<string>();
      pendingExistence = new Set<string>();
      pendingFields = new Map<string, Set<string>>();
    },
    notePut: (id, fields, inserted) => {
      if (pendingEpoch === null) throw new Error(`${options.modelId}: revision apply is not active`);
      pendingRows.add(id);
      if (inserted) pendingExistence.add(id);
      const current = pendingFields.get(id) ?? new Set<string>();
      for (const field of fields) if (field !== 'id') current.add(field);
      pendingFields.set(id, current);
    },
    noteDestroy: id => {
      if (pendingEpoch === null) throw new Error(`${options.modelId}: revision apply is not active`);
      pendingRows.add(id);
      pendingExistence.add(id);
    },
    commitApply: () => {
      if (pendingEpoch === null) throw new Error(`${options.modelId}: revision apply is not active`);
      for (const id of pendingRows) rowEpochs.set(id, pendingEpoch);
      for (const id of pendingExistence) existenceEpochs.set(id, pendingEpoch);
      for (const [id, fields] of pendingFields) {
        const current = fieldEpochs.get(id) ?? new Map<string, number>();
        for (const field of fields) current.set(field, pendingEpoch);
        fieldEpochs.set(id, current);
      }
      pendingEpoch = null;
      pendingRows.clear();
      pendingExistence.clear();
      pendingFields.clear();
    },
    abortApply: () => {
      pendingEpoch = null;
      pendingRows.clear();
      pendingExistence.clear();
      pendingFields.clear();
    },
    reset: () => {
      rowEpochs.clear();
      existenceEpochs.clear();
      fieldEpochs.clear();
      pendingEpoch = null;
      pendingRows.clear();
      pendingExistence.clear();
      pendingFields.clear();
    }
  };
  const planes = () => {
    if (planesRef) return planesRef;
    const runtime = getDbRuntimeConfig();
    const store = createModelStore<TStored & Record<string, unknown>>({
      modelId: options.modelId,
      now: () => Date.now(),
      storage: runtime.storage,
      prefix: getStoragePrefix,
      applyWriteGate: options.applyWriteGate as (
        previous: TStored & Record<string, unknown>,
        incoming: TStored & Record<string, unknown>,
        ctx: WriteCtx
      ) => TStored & Record<string, unknown>,
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
    revisions,
    issuedScopeSequence: key => issuedScopeSequences.get(key),
    setIssuedScopeSequence: (key, value) => {
      issuedScopeSequences.set(key, value);
    },
    model: <TModel,>(): TModel => modelRef as TModel,
    setModel: model => {
      modelRef = model;
    },
    reset: () => {
      revisions.reset();
      issuedScopeSequences.clear();
      planesRef?.scopeIndex.reset();
      storeRef?.reset();
      storeRef?.dispose();
      storeRef = null;
      planesRef = null;
    }
  };
};
