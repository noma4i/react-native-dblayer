import type { SyncContract } from '../types';
export type SideloadSpec<TInput = unknown> = {
    /** Registry name of the target model. */
    model: string;
    /** Collect nested raw payloads from one input item. */
    pluck: (input: TInput) => unknown | unknown[] | null | undefined;
    /** Sync-contract source label. */
    source?: string;
};
export declare const isModelApplying: (name: string) => boolean;
export declare const withApplyingModel: <T>(name: string, fn: () => T) => T;
export declare const runSideloads: (specs: SideloadSpec<any>[] | undefined, items: unknown[], parentContract: SyncContract) => void;
//# sourceMappingURL=sideload.d.ts.map