type WaiterModel<TStored extends {
    id: string;
}> = {
    modelId: string;
    get(id: string | null | undefined): TStored | undefined;
    patch(id: string, patch: Record<string, unknown>): void;
};
export type RowPatch<TStored> = Partial<TStored> | ((row: TStored) => Partial<TStored>);
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
 * Apply the patch now when the row exists, otherwise defer it on the commit bus until the row
 * appears or the TTL expires. Deferred patches for one row apply in registration order because
 * bus subscribers are notified in subscription order.
 */
export declare const patchWhenPresent: <TStored extends {
    id: string;
}>(model: WaiterModel<TStored>, id: string, patch: RowPatch<TStored>, options: PatchWhenPresentOptions) => void;
/** Resolve with the row once it exists, or with `undefined` on timeout/abort. */
export declare const waitForRow: <TStored extends {
    id: string;
}>(model: WaiterModel<TStored>, id: string, options: WaitForRowOptions) => Promise<TStored | undefined>;
export {};
//# sourceMappingURL=rowWaiters.d.ts.map