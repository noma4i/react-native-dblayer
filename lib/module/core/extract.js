"use strict";

/** Applies a resolved extract payload to application collections. */

/** Resolves a mutation extract spec with a server result. */

const defaultDbExtractSink = () => {};
const defaultDbMutationExtractResolver = extractSpec => extractSpec;
let currentDbExtractSink = defaultDbExtractSink;
let currentDbMutationExtractResolver = defaultDbMutationExtractResolver;

/** Set the sink used for query and mutation side-load payloads. */
export const setDbExtractSink = sink => {
  currentDbExtractSink = sink;
};

/** Get the currently configured extract sink. */
export const getDbExtractSink = () => currentDbExtractSink;

/** Set the resolver used to turn mutation extract specs into payloads. */
export const setDbMutationExtractResolver = resolver => {
  currentDbMutationExtractResolver = resolver;
};

/** Get the currently configured mutation extract resolver. */
export const getDbMutationExtractResolver = () => currentDbMutationExtractResolver;
//# sourceMappingURL=extract.js.map