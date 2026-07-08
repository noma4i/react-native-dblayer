import type { CollectionModel, StoredWriteInput } from '../types';
type RowId = {
    id: string;
    updatedAt?: string | null;
};
type RowCollection = {
    readonly id: string;
    subscribeChanges(callback: (changes: Array<{
        type: string;
        key?: unknown;
        value?: unknown;
    }>) => void, options: {
        includeInitialState: false;
    }): RowSubscription;
};
type RowSubscription = {
    unsubscribe(): void;
};
export type RowPatch<TStored extends RowId> = Partial<StoredWriteInput<TStored>> | ((row: TStored) => Partial<StoredWriteInput<TStored>>);
export type PatchWhenPresentOptions = {
    /** Maximum time to keep a deferred patch before dropping it. */
    ttlMs: number;
};
export type WaitForRowOptions = {
    /** Maximum time to wait before resolving with `undefined`. */
    timeoutMs: number;
    /** Optional abort signal that resolves the waiter with `undefined` and cleans up immediately. */
    signal?: AbortSignal;
};
/**
 * Apply a patch immediately when the row exists, or defer it until the row appears.
 *
 * Deferred patches are ordered per row id, expire after `ttlMs`, and are cleared on model runtime reset.
 *
 * @param model Model that owns the row and exposes its TanStack DB collection.
 * @param id Row id to patch.
 * @param patch Partial update or updater derived from the current row at application time.
 * @param options Deferred patch TTL.
 */
export declare const patchWhenPresent: <TStored extends RowId>(model: CollectionModel<unknown, TStored>, id: string, patch: RowPatch<TStored>, options: PatchWhenPresentOptions) => void;
/**
 * Resolve with a row once it exists, without polling.
 *
 * The waiter uses the model's TanStack DB `subscribeChanges` channel, resolves `undefined` on timeout
 * or abort, and removes timers/subscriptions on every exit path.
 *
 * @param model Model that owns the row and exposes its TanStack DB collection.
 * @param id Row id to wait for.
 * @param options Timeout and optional abort signal.
 * @returns Promise resolving to the row or `undefined`.
 */
export declare const waitForRow: <TStored extends RowId>(model: CollectionModel<unknown, TStored>, id: string, options: WaitForRowOptions) => Promise<TStored | undefined>;
/** Clear deferred row patches and waiters for a collection during model runtime reset. */
export declare const clearRowWaitersForCollection: (collection: RowCollection) => void;
/** Return internal waiter counts for leak-focused tests. */
export declare const getRowWaiterDebugInfo: (collection: RowCollection) => {
    patchQueues: number;
    waiters: number;
};
export {};
//# sourceMappingURL=rowWaiters.d.ts.map