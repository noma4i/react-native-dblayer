"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelQueryPlane = void 0;
var _db = require("@tanstack/db");
var _compileWhereExpression = require("./compileWhereExpression.js");
var _diagnostics = require("./diagnostics.js");
var _ordering = require("./ordering.js");
var _storeDerivedCollections = require("./storeDerivedCollections.js");
var _storeSync = require("./storeSync.js");
var _configure = require("../dsl/configure.js");
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
  const cache = (0, _storeDerivedCollections.createDerivedCollectionCache)('derivedCollections');
  const build = (key, spec) => {
    const collection = (0, _db.createLiveQueryCollection)({
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
        }) => fieldRef(row, order.field), (0, _ordering.canonicalOrderOptions)(order.direction)), filtered)
        // The id tie-break is stated, not inherited: the engine settling ties by collection key is
        // its own business, while equal keys resolving by id is this package's declared order.
        .orderBy(({
          row
        }) => fieldRef(row, 'id'), (0, _ordering.canonicalOrderOptions)('asc'));
        return spec.limit === undefined ? ordered : ordered.limit(spec.limit);
      },
      getKey: row => row.id
    });
    // The work a declaration costs is counted once on the query, not once per reader watching it.
    const counter = collection.subscribeChanges(changes => (0, _diagnostics.noteReadEngineApply)(changes.length), {
      includeInitialState: false
    });
    return {
      collection,
      cleanup: () => {
        counter.unsubscribe();
        return collection.cleanup();
      }
    };
  };
  return {
    query: (key, spec) => {
      const held = cache.acquire(key, () => build(key, spec));
      // A mounted query is a maintenance root: its rows are on screen even though its changes come
      // from the engine rather than from the commit bus.
      const releaseRoot = (0, _configure.getCommitBus)().retain([{
        kind: 'model',
        model: modelId
      }]);
      /** Query rows carry the engine's virtual properties; readers see stored fields only. */
      const stored = queried => Object.fromEntries(Object.entries(queried).filter(([field]) => !field.startsWith('$')));
      return {
        rows: () => {
          const materialized = [...held.collection.collection.toArray];
          (0, _diagnostics.noteReadEngineScan)(materialized.length);
          return materialized.map(row => stored(row));
        },
        subscribe: listener => {
          const delivery = (0, _storeSync.createStoreTransactionBatcher)(() => listener());
          const subscription = held.collection.collection.subscribeChanges(() => delivery.push([undefined]), {
            includeInitialState: false
          });
          return () => {
            delivery.dispose();
            subscription.unsubscribe();
          };
        },
        release: () => {
          releaseRoot();
          held.release();
        }
      };
    },
    dispose: () => {
      cache.disposeAll();
    }
  };
};
exports.createModelQueryPlane = createModelQueryPlane;
//# sourceMappingURL=storeModelQueries.js.map