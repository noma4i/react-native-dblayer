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
export type DbExtractModelSink = {
    /** Apply server payloads with the source merge contract. */
    applyServerData: (items: unknown[], contract: SyncContract) => unknown;
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
export declare const liftExtractNodes: (value: DbMutationExtractValue) => unknown[];
/**
 * Build a mutation extract resolver from a declarative preset table.
 * Boolean presets use the table reader; selector presets override the reader.
 */
export declare const createMutationExtractResolver: <TResult = unknown, TSinkKey extends string = string>(presetTable: DbMutationExtractPresetTable<TResult, TSinkKey>) => DbMutationExtractResolver;
/**
 * Build an extract sink from a declarative sink table.
 * Sink keys run in declaration order.
 */
export declare const createExtractSink: (sinkTable: DbExtractSinkTable) => DbExtractSink;
export {};
//# sourceMappingURL=extract.d.ts.map