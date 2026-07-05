"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.setDbMutationExtractResolver = exports.setDbExtractSink = exports.getDbMutationExtractResolver = exports.getDbExtractSink = void 0;
/** Applies a resolved extract payload to application collections. */

/** Resolves a mutation extract spec with a server result. */

const defaultDbExtractSink = () => {};
const defaultDbMutationExtractResolver = extractSpec => extractSpec;
let currentDbExtractSink = defaultDbExtractSink;
let currentDbMutationExtractResolver = defaultDbMutationExtractResolver;

/** Set the sink used for query and mutation side-load payloads. */
const setDbExtractSink = sink => {
  currentDbExtractSink = sink;
};

/** Get the currently configured extract sink. */
exports.setDbExtractSink = setDbExtractSink;
const getDbExtractSink = () => currentDbExtractSink;

/** Set the resolver used to turn mutation extract specs into payloads. */
exports.getDbExtractSink = getDbExtractSink;
const setDbMutationExtractResolver = resolver => {
  currentDbMutationExtractResolver = resolver;
};

/** Get the currently configured mutation extract resolver. */
exports.setDbMutationExtractResolver = setDbMutationExtractResolver;
const getDbMutationExtractResolver = () => currentDbMutationExtractResolver;
exports.getDbMutationExtractResolver = getDbMutationExtractResolver;
//# sourceMappingURL=extract.js.map