import type { DerivedCollection, DerivedCollectionCache } from '../types';
/**
 * One home for the lifetime of every collection derived from a store: scope windows and model
 * queries alike. A derived collection exists while at least one reader holds it and is disposed the
 * moment the last one leaves, so browsing scopes or filters does not accumulate live queries.
 *
 * Two caches would mean two answers to "when does a derived collection die", and the one that got
 * the answer wrong would leak quietly - nothing observable happens when a query stays alive.
 */
export declare const createDerivedCollectionCache: <TCollection extends DerivedCollection>(gauge: string) => DerivedCollectionCache<TCollection>;
//# sourceMappingURL=storeDerivedCollections.d.ts.map