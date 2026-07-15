import type { DbGraphQLDocument } from '../types';
import type { JournalOp } from '../core/apply/journal';
import type { ExtractSink } from './defineQuery';
type MutationModel = {
    modelId: string;
    get(id: string | null | undefined): unknown;
    normalize(input: unknown): {
        id: string;
    };
    insertStored(row: {
        id: string;
    }): void;
    patch(id: string, patch: Record<string, unknown>): void;
    destroy(id: string): void;
    __planReplace?(oldId: string, next: unknown): JournalOp[];
    __captureMembership?(id: string): Array<{
        id: string;
        scopeKey: string;
        order: number;
        edge?: Record<string, unknown>;
    }>;
    __planRestore?(next: unknown, memberships: Array<{
        id: string;
        scopeKey: string;
        order: number;
        edge?: Record<string, unknown>;
    }>): JournalOp[];
};
export type OptimisticCtx = {
    tempId: string | null;
};
export type MutateCallbacks<TData> = {
    /** Receives null when the call was skipped by dedupe (already committed / pending). */
    onSuccess?: (data: TData | null) => void;
    onError?: (error: Error) => void;
    onSettled?: () => void;
};
type InsertOptimistic<TData, TInput, TStored, TNode> = {
    model: MutationModel;
    tempIdPrefix?: string;
    build: (input: TInput, ctx: OptimisticCtx) => TStored;
    selectServerNode: (data: TData) => TNode | null | undefined;
    /** Client-only fields (visual state, local uris) carried from the optimistic row onto the committed server row. */
    preserveOnCommit?: ReadonlyArray<keyof TStored & string>;
    /** Retry path: reuse this existing optimistic row instead of inserting a new one; a failed retry keeps it. */
    existingTempId?: (input: TInput) => string | null;
};
type PatchOptimistic<TInput, TStored> = {
    method: 'patch';
    model: MutationModel;
    selectId: (input: TInput) => string;
    selectPatch: (input: TInput) => Partial<TStored>;
};
type DestroyOptimistic<TInput> = {
    method: 'destroy';
    model: MutationModel;
    selectId: (input: TInput) => string;
};
export type MutationConfig<TData, TInput, TStored, TNode> = {
    document: DbGraphQLDocument<TData, any>;
    /** Response field owning the mutation payload; a null payload is treated as failure and rolls back. */
    result: string;
    mapInput?: (input: TInput) => Record<string, unknown>;
    optimistic?: InsertOptimistic<TData, TInput, TStored, TNode> | PatchOptimistic<TInput, TStored> | DestroyOptimistic<TInput>;
    /** Cross-model sideloads from the response, applied in the SAME transaction as the commit. */
    extract?: (ctx: {
        data: TData;
    }) => ExtractSink[];
    /** Idempotency: a committed key is never re-sent; a pending key blocks double-taps; null skips dedupe. */
    dedupe?: {
        key: (input: TInput) => string | null;
    };
    onMutate?: (input: TInput, ctx: OptimisticCtx) => void;
    onCommit?: (data: TData, ctx: OptimisticCtx & {
        input: TInput;
    }) => void;
    onError?: (error: Error, ctx: OptimisticCtx & {
        input: TInput;
    }) => void;
    invalidate?: (ctx: {
        input: TInput;
        data: TData;
    }) => void;
    track?: (ctx: {
        input: TInput;
        data: TData;
    }) => void;
};
/** Define hook and imperative mutation paths with one lifecycle: optimistic -> transport -> single-transaction commit or rollback. */
export declare const defineMutation: <TData, TInput, TStored extends {
    id: string;
}, TNode>(config: MutationConfig<TData, TInput, TStored, TNode>) => {
    run: (input: TInput) => Promise<TData | null>;
    use: () => {
        mutate: (input: TInput, callbacks?: MutateCallbacks<TData>) => void;
        mutateAsync: (input: TInput) => Promise<TData | null>;
        isPending: boolean;
        error: Error | null;
    };
};
export {};
//# sourceMappingURL=defineMutation.d.ts.map