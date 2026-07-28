import type { ModelContext, RelationDecl, WriteCtx } from '../types';
export declare const createModelContext: <TStored extends {
    id: string;
}>(options: {
    modelId: string;
    scopeNames: readonly string[];
    relations: () => Record<string, RelationDecl>;
    applyWriteGate: (previous: TStored, incoming: TStored, ctx: WriteCtx) => TStored;
}) => ModelContext<TStored>;
//# sourceMappingURL=modelContext.d.ts.map