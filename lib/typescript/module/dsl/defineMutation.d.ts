import type { DbGraphQLDocument } from '../types';
type MutationModel = {
    get(id: string): unknown;
    insertStored(row: {
        id: string;
    }): void;
    patch(id: string, patch: Record<string, unknown>): void;
    destroy(id: string): void;
    replaceRaw(oldId: string, next: unknown): void;
};
export type OptimisticCtx = {
    tempId: string | null;
};
export type MutationConfig<TData, TInput, TStored, TNode> = {
    document: DbGraphQLDocument<TData, any>;
    result: string;
    mapInput?: (input: TInput) => Record<string, unknown>;
    optimistic?: {
        model: MutationModel;
        tempIdPrefix?: string;
        build: (input: TInput, ctx: OptimisticCtx) => TStored;
        selectServerNode: (data: TData) => TNode | null | undefined;
        preserveOnCommit?: ReadonlyArray<keyof TStored>;
    } | {
        method: 'patch';
        model: MutationModel;
        selectId: (input: TInput) => string;
        selectPatch: (input: TInput) => Partial<TStored>;
    } | {
        method: 'destroy';
        model: MutationModel;
        selectId: (input: TInput) => string;
    };
};
/** Define hook and imperative mutation paths with identical transport execution. */
export declare const defineMutation: <TData, TInput, TStored extends {
    id: string;
}, TNode>(config: MutationConfig<TData, TInput, TStored, TNode>) => {
    run: (input: TInput) => Promise<TData | null>;
    use: () => {
        mutate: (input: TInput) => void;
        mutateAsync: (input: TInput) => Promise<TData | null>;
        isPending: boolean;
        error: Error | null;
    };
};
export {};
//# sourceMappingURL=defineMutation.d.ts.map