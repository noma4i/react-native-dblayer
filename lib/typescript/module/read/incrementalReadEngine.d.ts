import type { Dependency, IncrementalCommitBatch } from '../types';
type Engine<T> = {
    signature: string;
    generation: number;
    value: T;
    version: number;
    apply(batch: IncrementalCommitBatch | null): boolean;
};
/** Canonical semantic descriptors preserve object identity only where leaf values require it. */
export declare const incrementalSignature: (kind: string, ...values: unknown[]) => string;
type EngineInput<T> = {
    signature: string;
    create(): Engine<T>;
    deps: ReadonlyArray<Dependency>;
};
type ReadEngineHarnessInput<T, TResult> = EngineInput<T> & {
    apply(engine: Engine<T>, batch: IncrementalCommitBatch | null): boolean;
    select(engine: Engine<T>): TResult;
    notifyEveryBatch?: boolean;
};
/** Shared React subscription harness for model and scope read engines. */
export declare const useReadEngineHarness: <T, TResult>({ signature, create, deps, apply, select, notifyEveryBatch }: ReadEngineHarnessInput<T, TResult>) => TResult;
/** Internal model-read bridge over the shared engine harness. */
export declare const useIncrementalRead: <T>({ signature, create, deps }: EngineInput<T>) => T;
type Row = {
    id: string;
    [key: string]: unknown;
};
type RowEngineOptions<T extends Row, TValue> = {
    signature: string;
    model: string;
    where(row: T): boolean;
    options?: {
        orderBy?: ReadonlyArray<{
            field: string;
            direction: 'asc' | 'desc';
        }>;
        limit?: number;
    };
    initial(): T[];
    read(id: string): T | undefined;
    select(rows: T[], count: number): TValue;
    isEqual?: (left: TValue, right: TValue) => boolean;
    countOnly?: boolean;
};
/** Sort model read results by declared keys with NULLS LAST and an implicit locale-independent id tie-breaker. */
export declare const sortModelReadRows: <T extends Row>(rows: T[], orderBy: ReadonlyArray<{
    field: string;
    direction: "asc" | "desc";
}>, limit?: number) => T[];
/** Apply an optional non-negative row limit; undefined means no limit. */
export declare const limitRows: <T>(rows: T[], limit: number | undefined) => T[];
/** P4 state: O(affected rows) delta application, with explicit rebuild fallback for bulk/reset paths. */
export declare const createModelReadEngine: <T extends Row, TValue>(options: RowEngineOptions<T, TValue>) => Engine<TValue>;
export {};
//# sourceMappingURL=incrementalReadEngine.d.ts.map