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