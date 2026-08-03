import type { EntityState } from './core.store.types';
import type { RelationDecl } from './core.relations.types';
import type { ScopeIndex } from './core.planes.scopeIndex.types';
export type ModelRevisionOwner<TStored extends {
    id: string;
}> = {
    admitRow(incoming: TStored, previous: TStored | undefined, baseRevision?: number): TStored | null;
    admitPatch(id: string, patch: Record<string, unknown>, remove: readonly string[], previous: TStored | undefined, baseRevision?: number): {
        patch: Record<string, unknown>;
        remove: string[];
    } | null;
    admitDestroy(id: string, baseRevision?: number): boolean;
    beginApply(epoch: number): void;
    notePut(id: string, fields: readonly string[], inserted: boolean): void;
    noteDestroy(id: string): void;
    commitApply(): void;
    abortApply(): void;
    reset(): void;
};
export type ModelContext<TStored extends {
    id: string;
}> = {
    planes(): {
        entityState: EntityState<TStored>;
        scopeIndex: ScopeIndex;
    };
    resolvedRelations(): Record<string, RelationDecl>;
    revisions: ModelRevisionOwner<TStored>;
    issuedScopeSequence(key: string): number | undefined;
    setIssuedScopeSequence(key: string, value: number): void;
    model<TModel>(): TModel;
    setModel(model: unknown): void;
    reset(): void;
};
//# sourceMappingURL=dsl.modelContext.types.d.ts.map