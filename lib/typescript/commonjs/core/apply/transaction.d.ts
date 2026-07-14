import type { JournalOp } from './journal';
import type { StoragePlane } from '../planes/storagePlane';
export type ApplyTarget = {
    upsert(rows: unknown[]): void;
    destroy(ids: string[]): void;
    counter(id: string, field: string, delta: number): void;
    scope(scopeHash: string, next: unknown): void;
};
export type ApplyRuntime = {
    apply(ops: JournalOp[]): void;
    replay(): void;
};
/** Register one model-owned application target for v6 plans. */
export declare const registerApplyTarget: (model: string, target: ApplyTarget) => (() => void);
/** Apply each plan once in memory, with a durable pending record before persistence flushes. */
export declare const createApplyRuntime: (storage: StoragePlane, prefix: string) => ApplyRuntime;
//# sourceMappingURL=transaction.d.ts.map