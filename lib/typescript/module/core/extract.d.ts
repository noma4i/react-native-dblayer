/** Applies a resolved extract payload to application collections. */
export type DbExtractSink = (extractResult: unknown, source: string) => void;
/** Resolves a mutation extract spec with a server result. */
export type DbMutationExtractResolver = (extractSpec: unknown, result: unknown) => unknown;
/** Set the sink used for query and mutation side-load payloads. */
export declare const setDbExtractSink: (sink: DbExtractSink) => void;
/** Get the currently configured extract sink. */
export declare const getDbExtractSink: () => DbExtractSink;
/** Set the resolver used to turn mutation extract specs into payloads. */
export declare const setDbMutationExtractResolver: (resolver: DbMutationExtractResolver) => void;
/** Get the currently configured mutation extract resolver. */
export declare const getDbMutationExtractResolver: () => DbMutationExtractResolver;
//# sourceMappingURL=extract.d.ts.map