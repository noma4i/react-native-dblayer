/** Applies a resolved extract payload to application collections. */
export type DbExtractSink = (extractResult: unknown, source: string) => void;
/** Resolves a mutation extract spec with a server result. */
export type DbMutationExtractResolver = (extractSpec: unknown, result: unknown) => unknown;

const defaultDbExtractSink: DbExtractSink = () => {};
const defaultDbMutationExtractResolver: DbMutationExtractResolver = extractSpec => extractSpec;

let currentDbExtractSink: DbExtractSink = defaultDbExtractSink;
let currentDbMutationExtractResolver: DbMutationExtractResolver = defaultDbMutationExtractResolver;

/** Set the sink used for query and mutation side-load payloads. */
export const setDbExtractSink = (sink: DbExtractSink): void => {
  currentDbExtractSink = sink;
};

/** Get the currently configured extract sink. */
export const getDbExtractSink = (): DbExtractSink => currentDbExtractSink;

/** Set the resolver used to turn mutation extract specs into payloads. */
export const setDbMutationExtractResolver = (resolver: DbMutationExtractResolver): void => {
  currentDbMutationExtractResolver = resolver;
};

/** Get the currently configured mutation extract resolver. */
export const getDbMutationExtractResolver = (): DbMutationExtractResolver => currentDbMutationExtractResolver;
