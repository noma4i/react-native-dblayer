import type { ModelApplyTargetResult, ScopeSpec, WriteOrigin, ModelContext } from '../types';
export declare const createModelApplyTarget: <TStored extends {
    id: string;
} & Record<string, unknown>>(options: {
    modelId: string;
    scopes: Record<string, ScopeSpec<TStored>> | undefined;
    context: ModelContext<TStored>;
    scopeSortedRows(scopeName: string, scopeValue: unknown): TStored[];
    writeRows(rows: unknown[], origin?: Exclude<WriteOrigin, "patch" | "snapshot">, mergeBase?: TStored, operationId?: string): Array<{
        id: string;
        changedFields: string[] | null;
    }>;
    patchRow(id: string, patch: Record<string, unknown>, operationId?: string): {
        id: string;
        changedFields: string[] | null;
    } | null;
}) => ModelApplyTargetResult;
//# sourceMappingURL=modelApplyTarget.d.ts.map