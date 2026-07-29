import type { DbWhere, ModelContext, ModelReadAccess, ReadOrder, ScopeSpec } from '../types';
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