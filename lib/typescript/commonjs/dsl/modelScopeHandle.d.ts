import type { ApplyTarget, Dependency, ModelContext, ScopeHandle, ScopeSpec, WriteOp } from '../types';
export declare const createModelScopeHandle: <TStored extends {
    id: string;
} & Record<string, unknown>, TInput>(options: {
    modelId: string;
    modelName: string;
    context: ModelContext<TStored>;
    scopes: Record<string, ScopeSpec<TStored>> | undefined;
    keyForScope(scopeName: string, scopeValue: unknown): string;
    scopeValueFromRow(by: Record<string, string>, row: Record<string, unknown>): Record<string, unknown> | null;
    isPlanRow(input: unknown): boolean;
    normalize(input: unknown): TStored;
    applyTarget: Pick<ApplyTarget, "scopeSortMeta">;
    scopeDep(scopeKey: string): Dependency;
    useScopeAccess(scopeKey: string | null): void;
    scopeSortedRows(scopeName: string, scopeValue: unknown): TStored[];
    planRows(rows: unknown[]): WriteOp[];
    applySnapshot(ops: WriteOp[]): void;
    applyEvent(ops: WriteOp[]): void;
}) => (scopeName: string) => ScopeHandle<TStored, Record<string, unknown>, TInput>;
//# sourceMappingURL=modelScopeHandle.d.ts.map