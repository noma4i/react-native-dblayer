"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelQueryPlane = void 0;
var _db = require("@tanstack/db");
var _compileWhereExpression = require("./compileWhereExpression.js");
var _ordering = require("./ordering.js");
var _storeDerivedCollections = require("./storeDerivedCollections.js");
var _storeSync = require("./storeSync.js");
const fieldRef = (row, field) => row[field];

/** A required field must carry a stored value; `null` is a value, an absent field is not. */
const presenceExpression = (row, required) => required.map(field => (0, _db.not)((0, _db.isUndefined)(fieldRef(row, field))));
const conditionExpression = (row, spec) => {
  const parts = [(0, _compileWhereExpression.compileWhereExpression)(row, spec.where), ...presenceExpression(row, spec.required)];
  return parts.length === 1 ? parts[0] : parts.reduce((left, right) => (0, _db.and)(left, right));
};

/**
 * Model reads as live queries of the collection engine. The declared filter, order and limit are
 * compiled once into a query the engine maintains incrementally; this package no longer keeps a
 * second engine that answers the same declaration by scanning rows itself.
 */
const createModelQueryPlane = options => {
  const {
    modelId,
    storeId,
    entities
  } = options;
  const cache = (0, _storeDerivedCollections.createDerivedCollectionCache)();
  const build = (key, spec) => (0, _db.createLiveQueryCollection)({
    ..._storeSync.OWNED_COLLECTION_LIFETIME,
    id: `dblayer-${modelId}-query-${storeId}-${key}`,
    startSync: true,
    query: q => {
      const filtered = q.from({
        row: entities
      }).where(({
        row
      }) => conditionExpression(row, spec));
      const ordered = spec.orderBy.reduce((builder, order) => builder.orderBy(({
        row
      }) => fieldRef(row, order.field), (0, _ordering.canonicalOrderOptions)(order.direction)), filtered).orderBy(({
        row
      }) => fieldRef(row, 'id'), (0, _ordering.canonicalOrderOptions)('asc'));
      return spec.limit === undefined ? ordered : ordered.limit(spec.limit);
    },
    getKey: row => row.id
  });
  return {
    query: (key, spec) => {
      const held = cache.acquire(key, () => build(key, spec));
      return {
        rows: () => [...held.collection.toArray].map(row => row),
        subscribe: listener => {
          const subscription = held.collection.subscribeChanges(() => listener(), {
            includeInitialState: false
          });
          return () => subscription.unsubscribe();
        },
        release: held.release
      };
    },
    dispose: () => {
      cache.disposeAll();
    }
  };
};
exports.createModelQueryPlane = createModelQueryPlane;
//# sourceMappingURL=storeModelQueries.js.map