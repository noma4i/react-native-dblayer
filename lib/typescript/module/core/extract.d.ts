import type { SyncContract } from '../types';
/** Applies a resolved extract payload to application collections. */
export type DbExtractSink = (extractResult: unknown, source: string) => void;
/** Resolves a mutation extract spec with a server result. */
export type DbMutationExtractResolver = (extractSpec: unknown, result: unknown) => unknown;
type DbMutationExtractValue = unknown | unknown[] | null | undefined;
export type DbMutationExtractPresetSelector<TResult = unknown> = (result: TResult) => DbMutationExtractValue;
export type DbMutationExtractPresetEntry<TResult = unknown, TSinkKey extends string = string> = {
    /** Default reader used when the mutation extract preset is `true`. */
    read: string | ((result: TResult) => DbMutationExtractValue);
    /** Output key consumed by the extract sink. */
    sink: TSinkKey;
    /**
     * Whether the resolved value should be emitted as an array.
     * @default true
     */
    many?: boolean;
};
export type DbMutationExtractPresetTable<TResult = unknown, TSinkKey extends string = string> = Record<string, DbMutationExtractPresetEntry<TResult, TSinkKey>>;
type ExtractPresetResult<TEntry> = TEntry extends DbMutationExtractPresetEntry<infer TResult, any> ? TResult : never;
/**
 * Derive the legal mutation extract config shape from a mutation extract preset table.
 *
 * The resulting spec accepts only declared preset keys. Each key supports `true` or a selector whose
 * result parameter matches that preset entry's `TResult`.
 */
export type ExtractSpecOf<TTable extends Record<string, DbMutationExtractPresetEntry<any, string>>> = {
    [K in keyof TTable]?: boolean | DbMutationExtractPresetSelector<ExtractPresetResult<TTable[K]>>;
};
export type DbExtractModelSink = {
    /** Apply server payloads with the resolved sync contract. */
    applyServerData: (items: unknown[], contract: SyncContract) => unknown;
    /** Override the sync contract for this sink's nodes and source. Defaults to `mergeSyncContract(source)`. */
    contract?: (nodes: unknown[], source: string) => SyncContract;
};
export type DbExtractCustomSink = (payload: unknown[], source: string) => void;
export type DbExtractSinkTable = Record<string, DbExtractModelSink | DbExtractCustomSink>;
/** Set the sink used for query and mutation side-load payloads. */
export declare const setDbExtractSink: (sink: DbExtractSink) => void;
/** Get the currently configured extract sink. */
export declare const getDbExtractSink: () => DbExtractSink;
/** Set the resolver used to turn mutation extract specs into payloads. */
export declare const setDbMutationExtractResolver: (resolver: DbMutationExtractResolver) => void;
/** Get the currently configured mutation extract resolver. */
export declare const getDbMutationExtractResolver: () => DbMutationExtractResolver;
/**
 * Normalize a mutation extract value into a compact array of non-null nodes.
 *
 * @param value Single node, node array, or nullish extract result.
 * @returns A node array with nullish entries removed.
 */
export declare const liftExtractNodes: (value: DbMutationExtractValue) => unknown[];
/**
 * Build a mutation extract resolver from a declarative preset table.
 * Boolean presets use the table reader; selector presets override the reader.
 */
export declare const createMutationExtractResolver: <TResult = unknown, TSinkKey extends string = string>(presetTable: DbMutationExtractPresetTable<TResult, TSinkKey>) => DbMutationExtractResolver;
/**
 * Build an extract sink from a declarative sink table.
 * Model sinks run first in declaration order, then custom function sinks run in declaration order.
 * Custom sinks can derive or patch rows inserted by model sinks from the same extract payload, including
 * when the custom key is declared before the model key.
 *
 * Every sink key's payload runs through `liftExtractNodes` before dispatch, so both branches see an
 * array regardless of whether the resolver produced a single value or an array (including the merged
 * multi-preset arrays `appendExtractValue` can now produce for a shared sink key): a model sink's
 * `applyServerData` always receives an array, and a custom function sink's `payload` argument is
 * always an array too.
 */
export declare const createExtractSink: (sinkTable: DbExtractSinkTable) => DbExtractSink;
export {};
//# sourceMappingURL=extract.d.ts.map