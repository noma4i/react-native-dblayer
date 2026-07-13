import type { CreateMergeConfig, MergeResult } from '../types';
/** Create a merge writer that upserts incoming rows when they are accepted by the freshness gate. */
export declare function createMerge<TInput, TOutput extends {
    id: string;
    updatedAt?: string | null;
}>(config: CreateMergeConfig<TInput, TOutput>): (items: TInput[], snapshotSeq?: number) => MergeResult;
//# sourceMappingURL=createMerge.d.ts.map