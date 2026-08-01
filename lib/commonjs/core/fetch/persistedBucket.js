"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.restorePersistedBucket = exports.persistBucket = void 0;
var _configure = require("../../dsl/configure.js");
var _queryPersistence = require("../queryPersistence.js");
/**
 * Move one bucket between storage and the query cache.
 *
 * Both reader surfaces land and store buckets the same way, and the parts that must agree are the
 * quiet ones: a record outside its window is discarded rather than shown, the stored timestamp
 * decides freshness instead of the moment of restore, and an invalidation that landed while the app
 * was closed is replayed. A second copy of this is how one surface starts trusting a record the
 * other would have thrown away.
 */
const restorePersistedBucket = args => {
  const record = (0, _queryPersistence.readPersistedQuery)(args.declaration, args.identity, args.validate);
  if (record === undefined) return undefined;
  if (args.window(record.empty) === null) {
    (0, _queryPersistence.removePersistedQuery)(args.declaration, args.identity);
    return undefined;
  }
  const cached = args.cache(record.payload);
  const client = (0, _configure.getDbQueryClient)();
  client.setQueryData(args.queryKey, cached, {
    updatedAt: record.dataUpdatedAt
  });
  if (record.invalidated) void client.invalidateQueries({
    queryKey: args.queryKey,
    exact: true,
    refetchType: 'none'
  });
  return cached;
};

/**
 * Store one landed bucket, or drop the stored one when this payload may not outlive the session.
 *
 * @see restorePersistedBucket for why both surfaces share this.
 */
exports.restorePersistedBucket = restorePersistedBucket;
const persistBucket = args => {
  if (args.window(args.empty) === null) {
    (0, _queryPersistence.removePersistedQuery)(args.declaration, args.identity);
    return;
  }
  (0, _queryPersistence.writePersistedQuery)({
    ...args.declaration,
    identity: args.identity,
    scope: args.scope,
    payload: args.payload,
    empty: args.empty,
    dataUpdatedAt: (0, _configure.getDbQueryClient)().getQueryState(args.queryKey).dataUpdatedAt
  });
};
exports.persistBucket = persistBucket;
//# sourceMappingURL=persistedBucket.js.map