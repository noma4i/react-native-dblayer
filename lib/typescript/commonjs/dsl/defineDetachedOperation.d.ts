import type { DetachedOperationConfig, DetachedOperationHandle } from '../types';
type DetachedModel<TStored extends {
    id: string;
}> = {
    modelId: string;
    update(id: string, patch: Partial<TStored>): void;
};
/** Define one durable operation whose executor is owned by the consumer and resumed by core at boot. */
export declare const defineDetachedOperation: <TInput, TStored extends {
    id: string;
}>(model: DetachedModel<TStored>, kind: string, config: DetachedOperationConfig<TInput, TStored>) => DetachedOperationHandle<TInput>;
/** Invoke every hydrated detached declaration once before startup GC and pending-TTL maintenance. */
export declare const reconcileDetachedOperationsAtBoot: () => Promise<void>;
export {};
//# sourceMappingURL=defineDetachedOperation.d.ts.map