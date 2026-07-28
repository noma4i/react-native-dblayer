import type { Engine, EngineInput, RowEngineOptions, RowRecord } from '../types';
/** Canonical semantic descriptors preserve object identity only where leaf values require it. */
export declare const incrementalSignature: (kind: string, ...values: unknown[]) => string;
/** Internal model-read bridge over the shared engine harness. */
export declare const useIncrementalRead: <T>({ signature, create, deps }: EngineInput<T>) => T;
/** Sort model read results by declared keys with NULLS LAST and an implicit locale-independent id tie-breaker. */
export declare const sortModelReadRows: <T extends RowRecord>(rows: T[], orderBy: ReadonlyArray<{
    field: string;
    direction: "asc" | "desc";
}>, limit?: number) => T[];
/** Apply an optional non-negative row limit; undefined means no limit. */
export declare const limitRows: <T>(rows: T[], limit: number | undefined) => T[];
/** P4 state: O(affected rows) delta application, with explicit rebuild fallback for bulk/reset paths. */
export declare const createModelReadEngine: <T extends RowRecord, TValue>(options: RowEngineOptions<T, TValue>) => Engine<TValue>;
//# sourceMappingURL=incrementalReadEngine.d.ts.map