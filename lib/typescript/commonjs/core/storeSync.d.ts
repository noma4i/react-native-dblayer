import type { ChangeMessageOrDeleteKeyMessage } from '@tanstack/db';
import type { StoreSyncMethods } from '../types';
export declare class SyncFeed<T extends object> {
    private methods;
    sync: (methods: StoreSyncMethods<T>) => (() => void);
    start(): void;
    pushMessage(message: ChangeMessageOrDeleteKeyMessage<T, string>): void;
    finish(): void;
    truncate(): void;
    markReady(): void;
    private requireMethods;
}
/**
 * Lifetime of every collection this package creates. The store that created a collection is the
 * only thing that ends its life: rows leave memory when the store evicts them - destroy, reset, or
 * dispose - and at no other moment.
 *
 * The collection library otherwise runs its own retention timer and clears a collection that spent
 * `gcTime` with no subscriber. Two things break when that fires behind the store: the rows are gone
 * while the app still holds them, and every index built over the collection keeps its keys, so a
 * lookup then names rows the collection no longer holds.
 */
export declare const OWNED_COLLECTION_LIFETIME: {
    readonly gcTime: number;
};
/**
 * Group every collection feed touched by one store transition. Nested callers join the same
 * package-owned boundary, and completion callbacks run only after every feed reached final state.
 */
export declare const runInStoreTransaction: <T>(run: () => T) => T;
export declare const isInStoreTransaction: () => boolean;
export declare const afterStoreTransaction: (complete: () => void) => void;
/**
 * Run one apply pass with batched collection flushes: every store write inside `run` lands in a
 * per-store transactional buffer (readable through the store immediately) and is committed to the
 * collections as one sync-feed transaction per store when the pass ends, so live queries observe
 * one consistent tick instead of per-row churn. A failure aborts every participating store buffer.
 */
export declare const runInApplyBatch: <T>(run: () => T) => T;
export declare const isInApplyBatch: () => boolean;
export declare const enqueueBatchParticipant: (participant: {
    flush(): void;
    abort(): void;
}) => void;
export declare const removeBatchParticipant: (participant: {
    flush(): void;
    abort(): void;
}) => void;
export declare const poisonStoreReads: () => void;
export declare const restoreStoreReads: () => void;
export declare const assertStoreReadable: () => void;
//# sourceMappingURL=storeSync.d.ts.map