import type { RelationDecl } from '../core/relations';
import { createEntityState, type EntityState } from '../core/planes/entityState';
import { createScopeIndex, type ScopeIndex } from '../core/planes/scopeIndex';
import { getDbRuntimeConfig, getOperationState, getStoragePrefix } from './configure';
import type { WriteCtx } from '../core/writePolicies';

export type ModelContext<TStored extends { id: string }> = {
  planes(): { entityState: EntityState<TStored>; scopeIndex: ScopeIndex };
  resolvedRelations(): Record<string, RelationDecl>;
  revision(): number;
  bumpRevision(): void;
  issuedScopeSequence(key: string): number | undefined;
  setIssuedScopeSequence(key: string, value: number): void;
  reset(): void;
};

export const createModelContext = <TStored extends { id: string }>(options: {
  modelId: string;
  scopeNames: readonly string[];
  relations: () => Record<string, RelationDecl>;
  applyWriteGate: (previous: TStored, incoming: TStored, ctx: WriteCtx) => TStored;
}): ModelContext<TStored> => {
  let planesRef: { entityState: EntityState<TStored>; scopeIndex: ScopeIndex } | null = null;
  let relationCache: Record<string, RelationDecl> | null = null;
  let revision = 0;
  const issuedScopeSequences = new Map<string, number>();
  const planes = () => {
    if (planesRef) return planesRef;
    const runtime = getDbRuntimeConfig();
    const entityState = createEntityState<TStored>({
      modelId: options.modelId,
      now: () => Date.now(),
      storage: runtime.storage,
      prefix: getStoragePrefix,
      applyWriteGate: options.applyWriteGate,
      ownedFields: (rowId, operationId) => getOperationState().ownedFields(options.modelId, rowId, operationId)
    });
    const scopeIndex = createScopeIndex({ modelId: options.modelId, scopeNames: [...options.scopeNames], storage: runtime.storage, prefix: getStoragePrefix });
    entityState.hydrate();
    scopeIndex.hydrate();
    planesRef = { entityState, scopeIndex };
    return planesRef;
  };
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
    reset: () => {
      revision += 1;
      issuedScopeSequences.clear();
      planesRef?.entityState.reset();
      planesRef?.scopeIndex.reset();
      planesRef = null;
    }
  };
};
