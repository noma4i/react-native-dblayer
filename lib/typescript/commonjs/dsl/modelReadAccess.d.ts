import type { DbWhere, ModelContext, ModelReadAccess, ReadOrder, ScopeSortSpec, ScopeSpec } from '../types';
/** Canonical scope-sort comparator: declared comparator or field order (NULLS LAST), always with the codepoint id tie-break shared by every read surface. */
export declare const compareRowsBySpec: <TRow extends {
    id: string;
}>(sort: ScopeSortSpec<TRow>) => ((left: TRow, right: TRow) => number);
export declare const createModelReadAccess: <TStored extends {
    id: string;
} & Record<string, unknown>>(options: {
    modelId: string;
    context: ModelContext<TStored>;
    scopes: Record<string, ScopeSpec<TStored>> | undefined;
    defaultOrder?: ReadOrder<TStored>;
    keyForScope(scopeName: string, scopeValue: unknown): string;
    matchesCriteria(row: TStored, where: DbWhere<TStored>): boolean;
}) => ModelReadAccess<TStored>;
//# sourceMappingURL=modelReadAccess.d.ts.map