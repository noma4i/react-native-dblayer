import type { ModelApplyTargetResult, PreparedRowWrite, ScopeSpec, WriteOrigin, ModelContext } from '../types';
export declare const createModelApplyTarget: <TStored extends {
    id: string;
} & Record<string, unknown>>(options: {
    modelId: string;
    scopes: Record<string, ScopeSpec<TStored>> | undefined;
    context: ModelContext<TStored>;
    scopeSortedRows(scopeName: string, scopeValue: unknown): TStored[];
    prepareRow(row: unknown, previous: TStored | undefined, origin?: Exclude<WriteOrigin, "patch" | "snapshot">, mergeBase?: TStored, operationId?: string): PreparedRowWrite | null;
    preparePatch(id: string, patch: Record<string, unknown>, previous: TStored | undefined, operationId?: string): PreparedRowWrite | null;
    putRows(rows: TStored[]): Array<{
        id: string;
        changedFields: string[] | null;
    }>;
}) => ModelApplyTargetResult;
//# sourceMappingURL=modelApplyTarget.d.ts.map