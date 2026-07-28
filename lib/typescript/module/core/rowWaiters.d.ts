import type { RowPatch, UpdateWhenRowExistsOptions, WaitForRowOptions, WaiterModel } from '../types';
/**
 * Apply the patch now when the row exists, otherwise defer it on the commit bus until the row
 * appears or the TTL expires. Deferred patches for one row apply in registration order because
 * bus subscribers are notified in subscription order.
 *
 * @param model Model to read and patch.
 * @param id Row id to patch now or wait for.
 * @param patch A partial update, or a function deriving one from the row once it is known.
 * @param options.ttlMs Maximum time to keep a deferred patch queued before dropping it.
 */
export declare const updateWhenRowExists: <TStored extends {
    id: string;
}>(model: WaiterModel<TStored>, id: string, patch: RowPatch<TStored>, options: UpdateWhenRowExistsOptions) => void;
/**
 * Resolve with the row once it exists, or with `undefined` on timeout/abort. Resolves immediately, without
 * subscribing, when the row already exists.
 *
 * @param model Model to read.
 * @param id Row id to wait for.
 * @param options.timeoutMs Maximum time to wait before resolving with `undefined`.
 * @param options.signal Optional abort signal that resolves with `undefined` and cleans up immediately.
 * @returns A promise for the row, or `undefined` on timeout/abort.
 */
export declare const waitForRow: <TStored extends {
    id: string;
}>(model: WaiterModel<TStored>, id: string, options: WaitForRowOptions) => Promise<TStored | undefined>;
//# sourceMappingURL=rowWaiters.d.ts.map