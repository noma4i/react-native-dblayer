import type { Dependency, IncrementalCommitBatch } from '../core/apply/commitBus';
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
/** Internal incremental subscription bridge. The public CommitBus contract remains unchanged. */
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
/** Sort model read results by declared keys with NULLS LAST and an implicit id tie-breaker. */
export declare const sortModelReadRows: <T extends Row>(rows: T[], orderBy: ReadonlyArray<{
    field: string;
    direction: "asc" | "desc";
}>, limit?: number) => T[];
/** Apply an optional non-negative row limit; undefined means no limit. */
export declare const limitRows: <T>(rows: T[], limit: number | undefined) => T[];
/** P4 state: O(affected rows) delta application, with explicit rebuild fallback for bulk/reset paths. */
export declare const createModelReadEngine: <T extends Row, TValue>(options: RowEngineOptions<T, TValue>) => Engine<TValue>;
type ScopeEngineOptions<T extends Row> = {
    signature: string;
    model: string;
    scopeKey: string;
    initial(): T[];
    read(id: string): T | undefined;
    sort?: {
        field: string;
        direction: 'asc' | 'desc';
    } | 'server-order' | {
        comparator: (left: T, right: T) => number;
    };
    windowSize?: number;
};
/** P5 state: one scope subscription, ephemeral epochs, and conservative comparator rebuilds. */
export declare const createScopeReadEngine: <T extends Row>(options: ScopeEngineOptions<T>) => Engine<T[]>;
export {};
//# sourceMappingURL=incrementalReadEngine.d.ts.map