import type { ApplyTarget, ModelContext, ScopeHandle, ScopeSpec, WriteOp } from '../types';
export declare const createModelScopeHandle: <TStored extends {
    id: string;
} & Record<string, unknown>, TInput>(options: {
    modelId: string;
    modelName: string;
    context: ModelContext<TStored>;
    scopes: Record<string, ScopeSpec<TStored>> | undefined;
    keyForScope(scopeName: string, scopeValue: unknown): string;
    normalizeScopeValue(scopeName: string, scopeValue: unknown): unknown;
    isScopeValueComplete(scopeName: string, scopeValue: unknown): boolean;
    scopeValueFromRow(by: Record<string, string>, row: Record<string, unknown>): Record<string, unknown> | null;
    admitPlanRow(input: unknown): TStored | undefined;
    normalize(input: unknown): TStored;
    applyTarget: Pick<ApplyTarget, "scopeSortMeta">;
    useScopeAccess(scopeKey: string | null): void;
    scopeSortedRows(scopeName: string, scopeValue: unknown): TStored[];
    planRows(rows: unknown[]): WriteOp[];
    applySnapshot(ops: WriteOp[]): void;
    applyEvent(ops: WriteOp[]): void;
}) => (scopeName: string) => ScopeHandle<TStored, Record<string, unknown>, TInput>;
//# sourceMappingURL=modelScopeHandle.d.ts.map