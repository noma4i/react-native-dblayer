import type { StoragePlane } from './planes/storagePlane';
export declare class CorruptionError extends Error {
    readonly keyClass: 'row' | 'tombstones' | 'scope';
    readonly storageKey: string;
    constructor(keyClass: 'row' | 'tombstones' | 'scope', storageKey: string);
}
/** Cold-model degradation: wipes every persisted snapshot key of the model (rows, tombstones, scopes, applied marker). WAL records are intentionally kept - replay re-applies un-checkpointed mutations over the clean slate. */
export declare const coldResetModel: (storage: StoragePlane, prefix: string, modelId: string) => void;
//# sourceMappingURL=recovery.d.ts.map