import type { DbGraphQLDocument } from '../types';
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
};
type ScopePlacementHandle = {
    modelId: string;
};
/** A server-order scope plus the mutation-input mapping that selects its concrete scope value. */
export type ScopePlacement<TInput> = {
    /** Server-order scope receiving the optimistic temp row. */
    scope: ScopePlacementHandle;
    /** Derive the destination scope value from the mutation input. */
    value: (input: TInput) => unknown;
};
/**
 * Context shared by optimistic and transport-variable builders for one mutation run.
 * Send `operationId` to the server, echo it on subscription events, and pass it as
 * `operationId` in the declaration returned by `defineIngest` to skip committed echoes.
 */
export type OptimisticCtx = {
    tempId: string | null;
    operationId: string;
};
export type MutateCallbacks<TData> = {
    /** Receives null when the call was skipped by dedupe (already committed / pending). */
    onSuccess?: (data: TData | null) => void;
    /** Called with the thrown error after rollback has already run. */
    onError?: (error: Error) => void;
    /** Called after `onSuccess`/`onError`, regardless of outcome. */
    onSettled?: () => void;
};
/**
 * Optimistic insert: writes a temp row immediately, then replaces it with the server node on commit
 * (or removes it on error/rollback).
 */
type InsertOptimistic<TData, TInput, TStored, TNode> = {
    /** Model the optimistic (and committed) row is written into. */
    model: MutationModel;
    /** Prefix passed to `generateTempId` for the inserted row's id. */
    tempIdPrefix?: string;
    /** Build the optimistic stored row from the mutation input and its `OptimisticCtx`. */
    build: (input: TInput, ctx: OptimisticCtx) => TStored;
    /** Pick the server-created node off the mutation response; `null`/`undefined` skips the temp-id replace. */
    selectServerNode: (data: TData) => TNode | null | undefined;
    /** Client-only fields (visual state, local uris) carried from the optimistic row onto the committed server row. */
    preserveOnCommit?: ReadonlyArray<keyof TStored & string>;
    /** Retry path: reuse this existing optimistic row instead of inserting a new one; a failed retry keeps it. */
    existingTempId?: (input: TInput) => string | null;
    /** Place the temp row at the top of this server-order scope; `value` derives that scope's value from the mutation input. */
    prependTo?: ScopePlacement<TInput>;
    /** Place the temp row at the bottom of this server-order scope; `value` derives that scope's value from the mutation input. */
    appendTo?: ScopePlacement<TInput>;
};
/** Optimistic patch: applies a partial update immediately, restoring the previous values on error. */
type PatchOptimistic<TInput, TStored> = {
    method: 'patch';
    /** Model the patch is applied to. */
    model: MutationModel;
    /** Row id to patch, derived from the mutation input. */
    selectId: (input: TInput) => string;
    /** Partial update applied immediately and re-derived on rollback to restore only the touched fields. */
    selectPatch: (input: TInput) => Partial<TStored>;
};
/**
 * Optimistic destroy: removes the row immediately, restoring it (and its scope memberships) on error.
 * Throws at run time if the model has a dependent cascade, since a cascaded destroy cannot be rolled back.
 */
type DestroyOptimistic<TInput> = {
    method: 'destroy';
    /** Model the row is destroyed from. */
    model: MutationModel;
    /** Row id to destroy, derived from the mutation input. */
    selectId: (input: TInput) => string;
};
type RespondOptimistic<TData, TInput, TNode> = {
    /** Model receiving the response node through the same normalize and swap plan as the transport response. */
    model: MutationModel;
    /** Pick the response node; an empty id is mapped to this run's temp id. */
    selectServerNode: (data: TData) => TNode | null | undefined;
    /** Fabricate a transport-shaped response for the optimistic apply; extract sinks run against it too. */
    respond: (input: TInput, ctx: {
        tempId: string;
        operationId: string;
    }) => TData;
    /** Place a fabricated temp row at the top of this server-order scope. */
    prependTo?: ScopePlacement<TInput>;
    /** Place a fabricated temp row at the bottom of this server-order scope. */
    appendTo?: ScopePlacement<TInput>;
};
export type MutationConfig<TData, TInput, TStored, TNode> = {
    /** The GraphQL mutation document. */
    document: DbGraphQLDocument<TData, any>;
    /** Response field owning the mutation payload; a null payload is treated as failure and rolls back. */
    result: string;
    /** Build transport variables from the mutation input and its optimistic operation context. */
    mapInput?: (input: TInput, ctx: OptimisticCtx) => Record<string, unknown>;
    /**
     * Optimistic local write applied before the network call, undone on error/rollback: an insert (writes a
     * temp row, replaced by the server node on commit), a `method: 'patch'`, or a `method: 'destroy'`. Omit
     * for mutations with no local write of their own (e.g. pure side-effect calls).
     */
    optimistic?: InsertOptimistic<TData, TInput, TStored, TNode> | RespondOptimistic<TData, TInput, TNode> | PatchOptimistic<TInput, TStored> | DestroyOptimistic<TInput>;
    /** Cross-model sideloads from the response, applied in the SAME transaction as the commit. */
    extract?: (ctx: {
        data: TData;
    }) => ExtractSink[];
    /** Idempotency: a committed key is never re-sent; a pending key blocks double-taps; null skips dedupe. */
    dedupe?: {
        key: (input: TInput) => string | null;
    };
    /** Called synchronously right after the optimistic write (if any), before the transport call starts. */
    onMutate?: (input: TInput, ctx: OptimisticCtx) => void;
    /** Called after the response commits successfully, after extract sinks and preserve-on-commit have applied. */
    onCommit?: (data: TData, ctx: OptimisticCtx & {
        input: TInput;
    }) => void;
    /** Called after a failed run has rolled back its optimistic write (if any) and closed the operation. */
    onError?: (error: Error, ctx: OptimisticCtx & {
        input: TInput;
    }) => void;
    /** Called after a successful commit to invalidate related queries; errors are logged and do not fail the mutation. */
    invalidate?: (ctx: {
        input: TInput;
        data: TData;
    }) => void;
    /** Called after a successful commit for analytics/tracking; errors are logged and do not fail the mutation. */
    track?: (ctx: {
        input: TInput;
        data: TData;
    }) => void;
};
/**
 * Define hook and imperative mutation paths with one lifecycle: optimistic write -> transport call ->
 * single-transaction commit (or rollback of the optimistic write on error/dedupe-skip). Dedupe, extract
 * sinks, and lifecycle callbacks (`onMutate`/`onCommit`/`onError`/`invalidate`/`track`) all run through
 * the same `run` path for both the hook and the direct call.
 *
 * @param config Document, result field, optional optimistic write, dedupe key, extract sinks, and lifecycle callbacks.
 * @returns `{ run, use }`. `run(input)` executes one mutation outside React, resolving to the response data,
 * or `null` when dedupe skipped it. `use()` is a hook returning `{ mutate, mutateAsync, isPending, error }`,
 * where `mutate` fires-and-forgets with optional `MutateCallbacks` and `mutateAsync` awaits/rejects like `run`.
 */
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