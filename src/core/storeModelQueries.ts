import { and, createLiveQueryCollection, isUndefined, not } from '@tanstack/db';
import { compileWhereExpression } from './compileWhereExpression';
import { canonicalOrderOptions } from './ordering';
import { createDerivedCollectionCache } from './storeDerivedCollections';
import { OWNED_COLLECTION_LIFETIME } from './storeSync';
import type { ModelQueryPlane, ModelQueryPlaneOptions, ModelQuerySpec, RowRecord, WhereExpression, WhereOperand, WhereRowRef } from '../types';

const fieldRef = (row: WhereRowRef, field: string): WhereOperand => row[field]!;

/** A required field must carry a stored value; `null` is a value, an absent field is not. */
const presenceExpression = (row: WhereRowRef, required: readonly string[]): WhereExpression[] => required.map(field => not(isUndefined(fieldRef(row, field))));

const conditionExpression = <TStored extends RowRecord>(row: WhereRowRef, spec: ModelQuerySpec<TStored>): WhereExpression => {
  const parts = [compileWhereExpression(row, spec.where), ...presenceExpression(row, spec.required)];
  return parts.length === 1 ? parts[0]! : parts.reduce((left, right) => and(left, right));
};

/**
 * Model reads as live queries of the collection engine. The declared filter, order and limit are
 * compiled once into a query the engine maintains incrementally; this package no longer keeps a
 * second engine that answers the same declaration by scanning rows itself.
 */
export const createModelQueryPlane = (options: ModelQueryPlaneOptions): ModelQueryPlane => {
  const { modelId, storeId, entities } = options;
  const cache = createDerivedCollectionCache<ReturnType<typeof build>>();

  const build = <TStored extends RowRecord>(key: string, spec: ModelQuerySpec<TStored>) =>
    createLiveQueryCollection({
      ...OWNED_COLLECTION_LIFETIME,
      id: `dblayer-${modelId}-query-${storeId}-${key}`,
      startSync: true,
      query: q => {
        const filtered = q.from({ row: entities }).where(({ row }) => conditionExpression(row as WhereRowRef, spec));
        const ordered = spec.orderBy
          .reduce(
            (builder, order) => builder.orderBy(({ row }) => fieldRef(row as WhereRowRef, order.field), canonicalOrderOptions(order.direction)),
            filtered
          )
          .orderBy(({ row }) => fieldRef(row as WhereRowRef, 'id'), canonicalOrderOptions('asc'));
        return spec.limit === undefined ? ordered : ordered.limit(spec.limit);
      },
      getKey: row => (row as RowRecord).id
    });

  return {
    query: (key, spec) => {
      const held = cache.acquire(key, () => build(key, spec));
      return {
        rows: () => [...held.collection.toArray].map(row => row as RowRecord),
        subscribe: listener => {
          const subscription = held.collection.subscribeChanges(() => listener(), { includeInitialState: false });
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
