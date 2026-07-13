import type { CreateReplaceConfig, ReplaceResult } from '../types';
/** Create a replace writer that upserts incoming rows and deletes rows missing from the incoming set. */
export declare function createReplace<TInput, TOutput extends {
    id: string;
}>(config: CreateReplaceConfig<TInput, TOutput>): (items: TInput[], scopeFilter?: (item: TOutput) => boolean, snapshotSeq?: number) => ReplaceResult;
//# sourceMappingURL=createReplace.d.ts.map