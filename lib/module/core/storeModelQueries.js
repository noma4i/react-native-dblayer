"use strict";

import { and, createLiveQueryCollection, isUndefined, not } from '@tanstack/db';
import { compileWhereExpression } from "./compileWhereExpression.js";
import { noteReadEngineApply, noteReadEngineScan } from "./diagnostics.js";
import { canonicalOrderOptions } from "./ordering.js";
import { createDerivedCollectionCache } from "./storeDerivedCollections.js";
import { OWNED_COLLECTION_LIFETIME } from "./storeSync.js";
import { getCommitBus } from "../dsl/configure.js";
const fieldRef = (row, field) => row[field];

/** A required field must carry a stored value; `null` is a value, an absent field is not. */
const presenceExpression = (row, required) => required.map(field => not(isUndefined(fieldRef(row, field))));
const conditionExpression = (row, spec) => {
  const parts = [compileWhereExpression(row, spec.where), ...presenceExpression(row, spec.required)];
  return parts.length === 1 ? parts[0] : parts.reduce((left, right) => and(left, right));
};

/**
 * Model reads as live queries of the collection engine. The declared filter, order and limit are
 * compiled once into a query the engine maintains incrementally; this package no longer keeps a
 * second engine that answers the same declaration by scanning rows itself.
 */
export const createModelQueryPlane = options => {
  const {
    modelId,
    storeId,
    entities
  } = options;
  const cache = createDerivedCollectionCache();
  const build = (key, spec) => {
    const collection = createLiveQueryCollection({
      ...OWNED_COLLECTION_LIFETIME,
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
        }) => fieldRef(row, order.field), canonicalOrderOptions(order.direction)), filtered)
        // The id tie-break is stated, not inherited: the engine settling ties by collection key is
        // its own business, while equal keys resolving by id is this package's declared order.
        .orderBy(({
          row
        }) => fieldRef(row, 'id'), canonicalOrderOptions('asc'));
        return spec.limit === undefined ? ordered : ordered.limit(spec.limit);
      },
      getKey: row => row.id
    });
    // The work a declaration costs is counted once on the query, not once per reader watching it.
    const counter = collection.subscribeChanges(changes => noteReadEngineApply(changes.length), {
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
      const releaseRoot = getCommitBus().retain([{
        kind: 'model',
        model: modelId
      }]);
      /** Query rows carry the engine's virtual properties; readers see stored fields only. */
      const stored = queried => Object.fromEntries(Object.entries(queried).filter(([field]) => !field.startsWith('$')));
      return {
        rows: () => {
          const materialized = [...held.collection.collection.toArray];
          noteReadEngineScan(materialized.length);
          return materialized.map(row => stored(row));
        },
        subscribe: listener => {
          const subscription = held.collection.collection.subscribeChanges(() => listener(), {
            includeInitialState: false
          });
          return () => subscription.unsubscribe();
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
//# sourceMappingURL=storeModelQueries.js.map